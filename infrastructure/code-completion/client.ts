import {
  codeCompletionResponseSchema,
  type CodeCompletionLanguage,
  type CodeCompletionRequest,
  type CodeCompletionResponse,
  type CodeCompletionSourceFile,
  type CodeCompletionTrigger,
} from "@/domains/code-completion/types";
import { browserApiFetch } from "@/infrastructure/http/browser-api";

const DEFAULT_AUTOMATIC_DEBOUNCE_MS = 350;
const MAX_PREFIX_CHARACTERS = 16_000;
const MAX_SUFFIX_CHARACTERS = 8_000;

export const CODE_COMPLETION_METRIC_EVENT = "webpilot:code-completion-metric";

export type CodeCompletionMetricName =
  | "request"
  | "shown"
  | "accepted"
  | "partially_accepted"
  | "rejected"
  | "cancelled"
  | "cache_hit"
  | "first_result";

export type CodeCompletionMetric = {
  name: CodeCompletionMetricName;
  projectId: string;
  path: string;
  projectRevision: number;
  requestId?: string;
  trigger?: CodeCompletionTrigger;
  model?: string;
  latencyMs?: number;
  value?: number;
  reason?: string;
};

export type CodeCompletionMetricSink = (metric: CodeCompletionMetric) => void;

export type CodeCompletionClientInput = {
  projectId: string;
  projectRevision: number;
  path: string;
  language: CodeCompletionLanguage;
  position: {
    lineNumber: number;
    column: number;
  };
  prefix: string;
  suffix: string;
  trigger: CodeCompletionTrigger;
  browserFiles?: readonly CodeCompletionSourceFile[];
  signal?: AbortSignal;
};

export type CodeCompletionClientResult = {
  generation: number;
  response: CodeCompletionResponse;
};

export type CodeCompletionClient = {
  request(
    input: CodeCompletionClientInput,
  ): Promise<CodeCompletionClientResult | null>;
  isCurrent(generation: number): boolean;
  cancel(reason?: string): void;
  dispose(): void;
};

type ActiveRequest = {
  controller: AbortController;
  fingerprint: string;
  generation: number;
  promise: Promise<CodeCompletionClientResult | null>;
  reportCancellation: (reason: string) => void;
};

type CodeCompletionClientOptions = {
  fetcher?: typeof browserApiFetch;
  metrics?: CodeCompletionMetricSink;
  automaticDebounceMs?: number;
  createRequestId?: () => string;
};

/**
 * Monaco 会在输入、光标移动和建议状态变化时多次请求 Provider。协调器把这些
 * 短生命周期调用压缩为单个网络请求，并用 generation 阻止已经过期的响应回流。
 * 它不持有 React state，因此高频输入不会额外触发工作台重渲染。
 */
export function createCodeCompletionClient(
  options: CodeCompletionClientOptions = {},
): CodeCompletionClient {
  const fetcher = options.fetcher ?? browserApiFetch;
  const metrics = options.metrics ?? emitCodeCompletionMetric;
  const debounceMs =
    options.automaticDebounceMs ?? DEFAULT_AUTOMATIC_DEBOUNCE_MS;
  const createRequestId =
    options.createRequestId ?? (() => crypto.randomUUID());
  let currentGeneration = 0;
  let active: ActiveRequest | null = null;
  let disposed = false;

  function cancelActive(reason: string) {
    if (!active) {
      return;
    }

    active.reportCancellation(reason);
    active.controller.abort(reason);
    active = null;
  }

  return {
    request(input) {
      if (disposed || input.signal?.aborted) {
        return Promise.resolve(null);
      }

      const request = createRequestPayload(input, createRequestId());
      const fingerprint = createClientFingerprint(input.projectId, request);

      // Monaco 可能为同一个模型版本重复调用 Provider。完全相同的请求复用
      // 当前 Promise，避免客户端先中止再重发，服务端也无需额外做一次解析。
      if (
        active &&
        !active.controller.signal.aborted &&
        active.fingerprint === fingerprint
      ) {
        return active.promise;
      }

      cancelActive("superseded");
      const generation = ++currentGeneration;
      const controller = new AbortController();
      let cancellationReported = false;
      const reportCancellation = (reason: string) => {
        if (cancellationReported) {
          return;
        }
        cancellationReported = true;
        metrics({
          name: "cancelled",
          projectId: input.projectId,
          path: input.path,
          projectRevision: input.projectRevision,
          requestId: request.clientRequestId,
          trigger: input.trigger,
          reason,
        });
      };

      const unlinkExternalSignal = linkAbortSignal(
        input.signal,
        controller,
        reportCancellation,
      );
      const promise = executeClientRequest({
        projectId: input.projectId,
        request,
        generation,
        debounceMs: input.trigger === "automatic" ? debounceMs : 0,
        controller,
        fetcher,
        metrics,
        reportCancellation,
      }).finally(() => {
        unlinkExternalSignal();
        if (active?.generation === generation) {
          active = null;
        }
      });

      active = {
        controller,
        fingerprint,
        generation,
        promise,
        reportCancellation,
      };
      return promise;
    },
    isCurrent(generation) {
      return !disposed && generation === currentGeneration;
    },
    cancel(reason = "cancelled") {
      cancelActive(reason);
      currentGeneration += 1;
    },
    dispose() {
      disposed = true;
      cancelActive("disposed");
      currentGeneration += 1;
    },
  };
}

async function executeClientRequest(input: {
  projectId: string;
  request: CodeCompletionRequest;
  generation: number;
  debounceMs: number;
  controller: AbortController;
  fetcher: typeof browserApiFetch;
  metrics: CodeCompletionMetricSink;
  reportCancellation: (reason: string) => void;
}): Promise<CodeCompletionClientResult | null> {
  try {
    await waitForDebounce(input.debounceMs, input.controller.signal);
    if (input.controller.signal.aborted) {
      return null;
    }

    input.metrics({
      name: "request",
      projectId: input.projectId,
      path: input.request.path,
      projectRevision: input.request.projectRevision,
      requestId: input.request.clientRequestId,
      trigger: input.request.trigger,
    });

    const response = await input.fetcher(
      `/api/projects/${encodeURIComponent(input.projectId)}/code-completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.request),
        signal: input.controller.signal,
      },
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? "代码补全请求失败。");
    }

    const completion = codeCompletionResponseSchema.parse(
      await response.json(),
    );
    input.metrics({
      name: "first_result",
      projectId: input.projectId,
      path: input.request.path,
      projectRevision: input.request.projectRevision,
      requestId: completion.requestId,
      trigger: input.request.trigger,
      model: completion.model,
      latencyMs: completion.latencyMs,
      value: completion.firstResultLatencyMs,
    });
    if (completion.cacheHit) {
      input.metrics({
        name: "cache_hit",
        projectId: input.projectId,
        path: input.request.path,
        projectRevision: input.request.projectRevision,
        requestId: completion.requestId,
        trigger: input.request.trigger,
        model: completion.model,
      });
    }

    return {
      generation: input.generation,
      response: completion,
    };
  } catch (error) {
    if (input.controller.signal.aborted || isAbortError(error)) {
      input.reportCancellation(
        String(input.controller.signal.reason || "aborted"),
      );
      return null;
    }
    throw error;
  }
}

function createRequestPayload(
  input: CodeCompletionClientInput,
  requestId: string,
): CodeCompletionRequest {
  return {
    clientRequestId: requestId,
    projectRevision: input.projectRevision,
    path: input.path,
    language: input.language,
    position: input.position,
    // 只保留最靠近光标的 prefix 和 suffix。完整项目上下文由服务端根据
    // import 和文件索引选择，避免每次敲键上传整份当前文件。
    prefix: input.prefix.slice(-MAX_PREFIX_CHARACTERS),
    suffix: input.suffix.slice(0, MAX_SUFFIX_CHARACTERS),
    trigger: input.trigger,
    browserContext: input.browserFiles
      ? { files: [...input.browserFiles] }
      : undefined,
  };
}

function createClientFingerprint(
  projectId: string,
  request: CodeCompletionRequest,
): string {
  return JSON.stringify({
    projectId,
    projectRevision: request.projectRevision,
    path: request.path,
    language: request.language,
    position: request.position,
    prefix: request.prefix,
    suffix: request.suffix,
    trigger: request.trigger,
    browserContext: request.browserContext,
  });
}

function waitForDebounce(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", abort, { once: true });
  });
}

function linkAbortSignal(
  signal: AbortSignal | undefined,
  controller: AbortController,
  reportCancellation: (reason: string) => void,
): () => void {
  if (!signal) {
    return () => undefined;
  }

  const abort = () => {
    reportCancellation("monaco_cancelled");
    controller.abort(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export function emitCodeCompletionMetric(metric: CodeCompletionMetric): void {
  if (typeof window === "undefined") {
    return;
  }

  // 体验指标与服务端费用账本分离。默认通过类型化浏览器事件暴露给未来的
  // Analytics/OpenTelemetry 适配器；单测可注入 sink 精确验证生命周期。
  window.dispatchEvent(
    new CustomEvent<CodeCompletionMetric>(CODE_COMPLETION_METRIC_EVENT, {
      detail: metric,
    }),
  );
}
