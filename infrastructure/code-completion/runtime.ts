import "server-only";

import { createHash } from "node:crypto";

import { AgentError, AGENT_ERROR_CODES } from "@/domains/agent/errors";
import type { AgentProviderRuntime } from "@/infrastructure/agent/provider-runtime-config";
import {
  buildCodeCompletionMessages,
  buildCodeCompletionPromptContext,
} from "@/domains/code-completion/context";
import {
  getCodeCompletionOutputLimits,
  sanitizeCodeCompletion,
} from "@/domains/code-completion/sanitize";
import type {
  CodeCompletionRequest,
  CodeCompletionResponse,
  CodeCompletionSourceFile,
} from "@/domains/code-completion/types";
import { getCodeCompletionProviderRuntime } from "@/infrastructure/agent/provider-factory";
import {
  recordCodeCompletionUsage,
  reserveCodeCompletionUsageBudget,
  settleCodeCompletionUsageBudget,
  type UsageBudgetReservation,
} from "@/infrastructure/quota/service";

const COMPLETION_CACHE_TTL_MS = 30_000;
const COMPLETION_CACHE_MAX_ENTRIES = 128;

type CompletionUsagePorts = {
  record: typeof recordCodeCompletionUsage;
  reserve: typeof reserveCodeCompletionUsageBudget;
  settle: typeof settleCodeCompletionUsageBudget;
};

type CompletionRuntimeOptions = {
  providerRuntime?: AgentProviderRuntime;
  usage?: Partial<CompletionUsagePorts>;
  now?: () => number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
};

type CompletionInput = {
  ownerId: string;
  request: CodeCompletionRequest;
  sourceFiles?: readonly CodeCompletionSourceFile[];
  /**
   * Database Repository 在服务端读取的 revision 作为第二道版本校验。
   * Browser Git 没有服务端 Repository 时由调用方省略，但客户端仍必须
   * 在 Monaco 插入前再次确认自己的编辑器版本。
   */
  currentProjectRevision?: number;
  signal?: AbortSignal;
};

type CachedCompletion = Omit<
  CodeCompletionResponse,
  "requestId" | "cacheHit"
> & {
  cachedAt: number;
};

type SharedCompletion = {
  controller: AbortController;
  task: Promise<RuntimeResult>;
  waiters: number;
  settled: boolean;
};

type RuntimeResult = {
  response: CodeCompletionResponse;
  cacheable: boolean;
};

export type CodeCompletionRuntime = {
  complete(input: CompletionInput): Promise<CodeCompletionResponse>;
};

/**
 * 行内补全运行时刻意独立于 Agent Run：
 *
 * - 不修改 Repository，不创建 revision，也不写 Transcript；
 * - 同一语义请求在短时间内共享 Provider 调用，避免快速输入重复扣费；
 * - 只有成功拿到当前 revision 的结果，客户端才有资格将 insertText 插回
 *   Monaco，服务端不会把补全当成已经落盘的代码事实。
 */
export function createCodeCompletionRuntime(
  options: CompletionRuntimeOptions = {},
): CodeCompletionRuntime {
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? COMPLETION_CACHE_TTL_MS;
  const maxCacheEntries =
    options.maxCacheEntries ?? COMPLETION_CACHE_MAX_ENTRIES;
  const cache = new Map<string, CachedCompletion>();
  const inFlight = new Map<string, SharedCompletion>();
  const usage: CompletionUsagePorts = {
    record: recordCodeCompletionUsage,
    reserve: reserveCodeCompletionUsageBudget,
    settle: settleCodeCompletionUsageBudget,
    ...options.usage,
  };

  return {
    async complete(input) {
      const providerRuntime =
        options.providerRuntime ?? getCodeCompletionProviderRuntime();
      const sourceFiles =
        input.sourceFiles ?? input.request.browserContext?.files;
      const fingerprint = createRequestFingerprint({
        ownerId: input.ownerId,
        request: input.request,
        sourceFiles,
      });

      const cached = readCache(cache, fingerprint, now(), cacheTtlMs);
      if (cached) {
        return materializeCachedResponse(cached, input.request.clientRequestId);
      }

      let shared = inFlight.get(fingerprint);

      if (!shared) {
        const controller = new AbortController();
        const task = runCompletion({
          ownerId: input.ownerId,
          request: input.request,
          sourceFiles: sourceFiles ?? [],
          currentProjectRevision: input.currentProjectRevision,
          providerRuntime,
          usage,
          requestFingerprint: fingerprint,
          signal: controller.signal,
          now,
        });
        const createdShared: SharedCompletion = {
          controller,
          task,
          waiters: 0,
          settled: false,
        };
        shared = createdShared;
        inFlight.set(fingerprint, createdShared);

        // 共享任务只允许在这里完成缓存写入和生命周期清理。不能把缓存写入
        // 放在 leader 的等待者里，否则 leader 取消而其他请求仍在等待时，
        // 成功结果会丢失；也不能用未消费的 finally 派生 Promise，Provider
        // 中止后可能在 Node.js 中形成 unhandled rejection。
        task.then(
          (result) => {
            if (result.cacheable) {
              writeCache(
                cache,
                fingerprint,
                toCachedCompletion(result.response, now()),
                maxCacheEntries,
              );
            }
            finalizeSharedCompletion(inFlight, fingerprint, createdShared);
          },
          () => {
            finalizeSharedCompletion(inFlight, fingerprint, createdShared);
          },
        );
      }

      const sharedCompletion = shared;
      sharedCompletion.waiters += 1;

      try {
        const result = await waitForAbort(sharedCompletion.task, input.signal);
        return input.request.clientRequestId === result.response.requestId
          ? result.response
          : {
              ...result.response,
              requestId: input.request.clientRequestId,
              cacheHit: true,
            };
      } finally {
        releaseSharedWaiter(sharedCompletion);
      }
    },
  };
}

function finalizeSharedCompletion(
  inFlight: Map<string, SharedCompletion>,
  fingerprint: string,
  shared: SharedCompletion,
): void {
  shared.settled = true;
  if (inFlight.get(fingerprint) === shared) {
    inFlight.delete(fingerprint);
  }
}

async function runCompletion(input: {
  ownerId: string;
  request: CodeCompletionRequest;
  sourceFiles: readonly CodeCompletionSourceFile[];
  currentProjectRevision?: number;
  providerRuntime: AgentProviderRuntime;
  usage: CompletionUsagePorts;
  requestFingerprint: string;
  signal: AbortSignal;
  now: () => number;
}): Promise<RuntimeResult> {
  const startedAt = input.now();
  const { request } = input;

  if (
    input.currentProjectRevision !== undefined &&
    input.currentProjectRevision !== request.projectRevision
  ) {
    return {
      response: emptyResponse({
        request,
        model: input.providerRuntime.model,
        latencyMs: 0,
        firstResultLatencyMs: 0,
        reason: "stale_revision",
      }),
      cacheable: false,
    };
  }

  const context = buildCodeCompletionPromptContext(request, input.sourceFiles);
  const messages = buildCodeCompletionMessages({ request, context });
  const limits = getCodeCompletionOutputLimits(request.trigger);
  const estimatedInputTokens = Math.max(
    1,
    Math.ceil(
      messages.reduce(
        (total, message) =>
          total +
          (typeof message.content === "string" ? message.content.length : 0),
        0,
      ) / 4,
    ),
  );

  let reservation: UsageBudgetReservation | null = null;
  let providerRequestStarted = false;
  let usageObserved = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let firstResultLatencyMs = 0;
  let rawText = "";
  let failure: unknown = null;

  try {
    reservation = await input.usage.reserve({
      ownerId: input.ownerId,
      projectRevision: request.projectRevision,
      requestFingerprint: input.requestFingerprint,
      provider: input.providerRuntime.providerName,
      model: input.providerRuntime.model,
      estimatedInputTokens,
      maxOutputTokens: limits.maxOutputTokens,
    });

    // 账本中的 settled 或 active Claim 都代表其他实例正在处理同一语义
    // 请求。补全结果没有跨实例持久化，因此这里返回可重试的空结果，而不是
    // 冒险再次调用 Provider 造成重复费用。
    if (reservation?.alreadySettled || reservation?.acquired === false) {
      return {
        response: emptyResponse({
          request,
          model: input.providerRuntime.model,
          latencyMs: input.now() - startedAt,
          firstResultLatencyMs: 0,
          reason: "in_flight",
        }),
        cacheable: false,
      };
    }

    const stream = input.providerRuntime.provider.streamTurn({
      model: input.providerRuntime.model,
      messages,
      tools: [],
      maxOutputTokens: limits.maxOutputTokens,
      userId: input.ownerId,
      signal: input.signal,
    });
    providerRequestStarted = true;

    for await (const event of stream) {
      if (event.type === "text_delta") {
        if (firstResultLatencyMs === 0) {
          firstResultLatencyMs = Math.max(0, input.now() - startedAt);
        }
        rawText += event.text;
      } else if (event.type === "usage") {
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        usageObserved = true;
      }
    }
  } catch (error) {
    failure = error;
  }

  const latencyMs = Math.max(0, input.now() - startedAt);
  await recordAndSettleUsage(input, {
    reservation,
    inputTokens,
    outputTokens,
    providerRequestStarted,
    usageObserved,
    latencyMs,
    projectRevision: request.projectRevision,
    requestFingerprint: input.requestFingerprint,
  });

  if (failure) {
    if (isAbortError(failure) || input.signal.aborted) {
      throw failure;
    }

    return {
      response: emptyResponse({
        request,
        model: input.providerRuntime.model,
        latencyMs,
        firstResultLatencyMs,
        reason: "completion_failed",
      }),
      cacheable: false,
    };
  }

  const insertText = sanitizeCodeCompletion({
    rawText,
    prefix: request.prefix,
    suffix: request.suffix,
    trigger: request.trigger,
  });

  if (!insertText) {
    return {
      response: emptyResponse({
        request,
        model: input.providerRuntime.model,
        latencyMs,
        firstResultLatencyMs,
        reason: classifyEmptyOutput(rawText, request.trigger),
      }),
      cacheable: false,
    };
  }

  return {
    response: {
      requestId: request.clientRequestId,
      projectRevision: request.projectRevision,
      insertText,
      model: input.providerRuntime.model,
      latencyMs,
      firstResultLatencyMs,
      cacheHit: false,
    },
    cacheable: true,
  };
}

async function recordAndSettleUsage(
  input: {
    ownerId: string;
    providerRuntime: AgentProviderRuntime;
    usage: CompletionUsagePorts;
    now: () => number;
  },
  usage: {
    reservation: UsageBudgetReservation | null;
    inputTokens: number;
    outputTokens: number;
    providerRequestStarted: boolean;
    usageObserved: boolean;
    latencyMs: number;
    projectRevision: number;
    requestFingerprint: string;
  },
): Promise<void> {
  if (usage.providerRequestStarted && !usage.reservation) {
    try {
      await input.usage.record({
        ownerId: input.ownerId,
        provider: input.providerRuntime.providerName,
        model: input.providerRuntime.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        projectRevision: usage.projectRevision,
        requestFingerprint: usage.requestFingerprint,
      });
    } catch (error) {
      console.error("[code-completion] usage record failed", { error });
    }
  }

  try {
    await input.usage.settle({
      reservation: usage.reservation,
      provider: input.providerRuntime.providerName,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      providerRequestStarted: usage.providerRequestStarted,
      usageObserved: usage.usageObserved,
      latencyMs: usage.latencyMs,
    });
  } catch (error) {
    // 计费记录属于观测和预算边界，不能覆盖已经拿到的补全结果；失败会
    // 保留在服务端日志中，后续由 Usage Ledger 对账任务发现并修复。
    console.error("[code-completion] usage settlement failed", { error });
  }
}

function emptyResponse(input: {
  request: CodeCompletionRequest;
  model: string;
  latencyMs: number;
  firstResultLatencyMs: number;
  reason:
    | "no_suggestion"
    | "in_flight"
    | "stale_revision"
    | "invalid_model_response"
    | "completion_too_long"
    | "completion_failed";
}): CodeCompletionResponse {
  return {
    requestId: input.request.clientRequestId,
    projectRevision: input.request.projectRevision,
    insertText: "",
    model: input.model,
    latencyMs: input.latencyMs,
    firstResultLatencyMs: input.firstResultLatencyMs,
    cacheHit: false,
    reason: input.reason,
  };
}

function classifyEmptyOutput(
  rawText: string,
  trigger: CodeCompletionRequest["trigger"],
): "no_suggestion" | "invalid_model_response" | "completion_too_long" {
  if (!rawText.trim()) {
    return "no_suggestion";
  }

  const limits = getCodeCompletionOutputLimits(trigger);
  if (
    rawText.length > limits.maxCharacters ||
    rawText.split(/\r\n?|\n/).length > limits.maxLines ||
    rawText.includes("```")
  ) {
    return "completion_too_long";
  }

  return "invalid_model_response";
}

function createRequestFingerprint(input: {
  ownerId: string;
  request: CodeCompletionRequest;
  sourceFiles?: readonly CodeCompletionSourceFile[];
}): string {
  const sourceFiles = [...(input.sourceFiles ?? [])]
    .map((file) => ({ path: file.path, content: file.content }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
  const payload = JSON.stringify({
    ownerId: input.ownerId,
    request: {
      ...input.request,
      clientRequestId: undefined,
    },
    sourceFiles,
  });

  return createHash("sha256").update(payload).digest("hex");
}

function readCache(
  cache: Map<string, CachedCompletion>,
  key: string,
  now: number,
  ttlMs: number,
): CachedCompletion | null {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }
  if (now - cached.cachedAt > ttlMs) {
    cache.delete(key);
    return null;
  }

  // Map 的插入顺序同时承担 LRU 顺序；命中后移到队尾，避免热门文件
  // 被自动补全请求挤出短期缓存。
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function writeCache(
  cache: Map<string, CachedCompletion>,
  key: string,
  value: CachedCompletion,
  maxEntries: number,
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > Math.max(1, maxEntries)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function toCachedCompletion(
  response: CodeCompletionResponse,
  cachedAt: number,
): CachedCompletion {
  return {
    projectRevision: response.projectRevision,
    insertText: response.insertText,
    model: response.model,
    latencyMs: response.latencyMs,
    firstResultLatencyMs: response.firstResultLatencyMs,
    ...(response.reason ? { reason: response.reason } : {}),
    cachedAt,
  };
}

function materializeCachedResponse(
  cached: CachedCompletion,
  requestId: string,
): CodeCompletionResponse {
  return {
    requestId,
    projectRevision: cached.projectRevision,
    insertText: cached.insertText,
    model: cached.model,
    latencyMs: 0,
    firstResultLatencyMs: 0,
    cacheHit: true,
    ...(cached.reason ? { reason: cached.reason } : {}),
  };
}

function releaseSharedWaiter(shared: SharedCompletion): void {
  shared.waiters = Math.max(0, shared.waiters - 1);
  if (shared.waiters === 0 && !shared.settled) {
    // 只有最后一个等待者取消时才终止共享 Provider 请求，避免一个快速
    // 输入的旧请求取消后，把仍在等待同一结果的另一个编辑器请求一起打断。
    shared.controller.abort();
  }
}

async function waitForAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw createCompletionAbortError();
  }

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(createCompletionAbortError());
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

function createCompletionAbortError(): AgentError {
  return new AgentError(
    AGENT_ERROR_CODES.providerInterrupted,
    "代码补全请求已取消。",
    499,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof AgentError &&
    error.code === AGENT_ERROR_CODES.providerInterrupted &&
    error.status === 499
  );
}
