import type { LlmProvider } from "@/domains/agent/provider";
import type {
  AgentRunRecord,
  ContextCheckpoint,
  TranscriptMessage,
} from "@/domains/agent/types";
import {
  assembleProviderMessages,
  estimateProviderContextCharacters,
} from "@/domains/agent/transcript";
import type {
  UsageBudgetReservation,
  recordContextCheckpointUsage,
  reserveContextCheckpointUsageBudget,
  settleContextCheckpointUsageBudget,
} from "@/infrastructure/quota/service";

export const FALLBACK_CONTEXT_CHARACTERS = 96_000;
const CHECKPOINT_TRIGGER_RATIO = 0.7;
const RETAINED_INTERACTION_GROUPS = 24;
const SUMMARY_MAX_OUTPUT_TOKENS = 2_048;
const MAX_CHECKPOINT_CAS_ATTEMPTS = 3;

export type ContextCheckpointStore = {
  getContextCheckpoint(input: {
    ownerId: string;
    conversationId: string;
  }): Promise<ContextCheckpoint>;
  compareAndSetContextCheckpoint(input: {
    ownerId: string;
    conversationId: string;
    expectedVersion: number;
    summary: string;
    transcriptSeq: number;
  }): Promise<boolean>;
  appendEvent(input: {
    runId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
};

type CheckpointUsagePorts = {
  record?: typeof recordContextCheckpointUsage;
  reserve?: typeof reserveContextCheckpointUsageBudget;
  settle?: typeof settleContextCheckpointUsageBudget;
};

/**
 * Checkpoint 只压缩“确定已经闭合且足够旧”的 Transcript 前缀。当前 Run、
 * 最近 24 组用户交互、未闭合工具调用以及最近失败工具所在区间都会留下完整
 * 原文，因此摘要不会拆散 Provider 要求严格配对的 tool_call/tool_result。
 */
export async function ensureContextCheckpoint(input: {
  store: ContextCheckpointStore;
  provider: LlmProvider;
  providerName: string;
  model: string;
  run: AgentRunRecord;
  transcript: readonly TranscriptMessage[];
  systemPrompt: string;
  /**
   * 当前主 Agent 模型可接收的上下文字符预算。Provider 能提供窗口元数据时
   * 按其 70% 提前压缩；代理模型或未知模型没有可靠数据时回退 96k。
   */
  maxContextCharacters?: number;
  signal?: AbortSignal;
  usage?: CheckpointUsagePorts;
}): Promise<ContextCheckpoint> {
  const maxContextCharacters = normalizeContextCharacters(
    input.maxContextCharacters,
  );
  const checkpointTriggerCharacters = Math.floor(
    maxContextCharacters * CHECKPOINT_TRIGGER_RATIO,
  );
  let checkpoint = await input.store.getContextCheckpoint({
    ownerId: input.run.ownerId,
    conversationId: input.run.conversationId,
  });

  for (let attempt = 1; attempt <= MAX_CHECKPOINT_CAS_ATTEMPTS; attempt += 1) {
    const projected = assembleProviderMessages(input.transcript, {
      systemPrompt: input.systemPrompt,
      contextCheckpoint: checkpoint,
      // Conversation 级 Checkpoint 可能由另一个并发 Run 先推进。阈值估算
      // 必须始终包含当前 Run 的完整原文，否则会低估本次模型调用的真实上下文。
      protectedRunId: input.run.id,
      maxContextCharacters: Number.MAX_SAFE_INTEGER,
    });
    if (
      estimateProviderContextCharacters(projected) < checkpointTriggerCharacters
    ) {
      return checkpoint;
    }

    const transcriptSeq = selectCheckpointTranscriptSeq(
      input.transcript,
      checkpoint.transcriptSeq,
      input.run.id,
    );
    if (transcriptSeq <= checkpoint.transcriptSeq) {
      return checkpoint;
    }

    const source = input.transcript.filter(
      (message) =>
        (message.seq ?? 0) > checkpoint.transcriptSeq &&
        (message.seq ?? 0) <= transcriptSeq &&
        message.kind !== "system_event",
    );
    const sourceCheckpoint = checkpoint;
    const startedAt = Date.now();
    let reservation: UsageBudgetReservation | null = null;
    let providerRequestStarted = false;
    let usageObserved = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let summary: string | null = null;
    let casUpdated = false;
    let attemptError: unknown = null;

    try {
      const summaryInput = formatSummaryInput(sourceCheckpoint.summary, source);
      reservation =
        (await input.usage?.reserve?.({
          ownerId: input.run.ownerId,
          agentRunId: input.run.id,
          conversationId: input.run.conversationId,
          checkpointVersion: sourceCheckpoint.version,
          transcriptSeq,
          provider: input.providerName,
          model: input.model,
          estimatedInputTokens: Math.max(1, Math.ceil(summaryInput.length / 4)),
          maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        })) ?? null;

      // settled 表示该边界已经完成；acquired=false 表示另一个并发 Run 正在
      // 生成同一摘要。两种情况都不再调用 Provider，本轮继续使用最后一个
      // 可靠 Checkpoint 与安全裁剪，下一轮会重新读取赢家提交的版本。
      if (reservation?.alreadySettled || reservation?.acquired === false) {
        await appendCheckpointEventSafely(input.store, input.run.id, {
          type: "context_checkpoint.retry_suppressed",
          payload: {
            transcriptSeq,
            version: sourceCheckpoint.version,
            reason: reservation.alreadySettled
              ? "already_settled"
              : "claim_not_acquired",
          },
        });
        return checkpoint;
      }

      let streamedSummary = "";
      const stream = input.provider.streamTurn({
        model: input.model,
        messages: [
          {
            role: "system",
            content:
              "你负责压缩 Agent 编码会话。保留用户目标、已完成工作、关键文件与 revision、技术决策、未解决问题、错误和后续动作。不要虚构事实，不要输出 Markdown 围栏。",
          },
          { role: "user", content: summaryInput },
        ],
        tools: [],
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        userId: input.run.ownerId,
        signal: input.signal,
      });
      // streamTurn 同步创建 AsyncIterable 时还没有进入网络请求；只有成功拿到
      // iterable 后才采用保守的“Provider 已开始”语义。同步构造失败会释放预留，
      // 下一次可以安全重试；迭代阶段失败则按上限结算并阻止同边界立即重试。
      providerRequestStarted = true;
      for await (const event of stream) {
        if (event.type === "text_delta") {
          streamedSummary += event.text;
        } else if (event.type === "usage") {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          usageObserved = true;
        }
      }

      summary = streamedSummary.trim();
      if (!summary) {
        throw new Error("摘要模型返回了空内容。");
      }

      casUpdated = await input.store.compareAndSetContextCheckpoint({
        ownerId: input.run.ownerId,
        conversationId: input.run.conversationId,
        expectedVersion: sourceCheckpoint.version,
        summary,
        transcriptSeq,
      });
    } catch (error) {
      attemptError = error;
    }

    const latencyMs = Date.now() - startedAt;
    // 预算关闭时使用兼容账本记录实际调用；记录失败只影响观测，不得回滚
    // 已经通过 CAS 持久化的 Checkpoint，也不能中断主 Agent。
    if (providerRequestStarted && !reservation) {
      await recordCheckpointUsageSafely(input, {
        checkpointVersion: sourceCheckpoint.version,
        transcriptSeq,
        inputTokens,
        outputTokens,
        latencyMs,
      });
    }
    await settleCheckpointUsageSafely(input, {
      reservation,
      checkpointVersion: sourceCheckpoint.version,
      transcriptSeq,
      inputTokens,
      outputTokens,
      providerRequestStarted,
      usageObserved,
      latencyMs,
    });

    if (attemptError || !summary) {
      // 摘要是上下文优化，不是执行业务事实。Provider、预算预留或 CAS 写入
      // 失败时继续使用最后一个可靠 Checkpoint，主循环随后仍有安全裁剪兜底。
      await appendCheckpointEventSafely(input.store, input.run.id, {
        type: "context_checkpoint.failed",
        payload: {
          attempt,
          transcriptSeq,
          version: sourceCheckpoint.version,
          message: errorMessage(attemptError),
        },
      });
      return checkpoint;
    }

    if (casUpdated) {
      checkpoint = {
        summary,
        transcriptSeq,
        version: sourceCheckpoint.version + 1,
        updatedAt: new Date(),
      };
      await appendCheckpointEventSafely(input.store, input.run.id, {
        type: "context_checkpoint.completed",
        payload: {
          attempt,
          transcriptSeq,
          version: checkpoint.version,
          latencyMs,
        },
      });
      return checkpoint;
    }

    // CAS 冲突只表示另一个 Run 先提交，不是摘要失败。读取赢家后重新估算
    // 剩余上下文；若赢家已覆盖足够内容，下一轮会直接返回而不重复调用模型。
    try {
      checkpoint = await input.store.getContextCheckpoint({
        ownerId: input.run.ownerId,
        conversationId: input.run.conversationId,
      });
    } catch (error) {
      await appendCheckpointEventSafely(input.store, input.run.id, {
        type: "context_checkpoint.failed",
        payload: {
          attempt,
          transcriptSeq,
          version: sourceCheckpoint.version,
          message: `CAS 冲突后读取最新 Checkpoint 失败：${errorMessage(error)}`,
        },
      });
      return sourceCheckpoint;
    }
    await appendCheckpointEventSafely(input.store, input.run.id, {
      type: "context_checkpoint.cas_conflicted",
      payload: {
        attempt,
        attemptedTranscriptSeq: transcriptSeq,
        winnerTranscriptSeq: checkpoint.transcriptSeq,
        winnerVersion: checkpoint.version,
      },
    });
  }

  return checkpoint;
}

/**
 * Provider 元数据属于外部输入，必须在领域边界做一次有限数校验。
 * 非法值不能把裁剪关闭或制造负数阈值，统一退回经过长期验证的 96k。
 */
export function normalizeContextCharacters(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : FALLBACK_CONTEXT_CHARACTERS;
}

async function recordCheckpointUsageSafely(
  input: Parameters<typeof ensureContextCheckpoint>[0],
  usage: {
    checkpointVersion: number;
    transcriptSeq: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  },
): Promise<void> {
  try {
    await input.usage?.record?.({
      ownerId: input.run.ownerId,
      agentRunId: input.run.id,
      conversationId: input.run.conversationId,
      checkpointVersion: usage.checkpointVersion,
      transcriptSeq: usage.transcriptSeq,
      provider: input.providerName,
      model: input.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: usage.latencyMs,
    });
  } catch (error) {
    console.error("[context-checkpoint] usage record failed", {
      runId: input.run.id,
      transcriptSeq: usage.transcriptSeq,
      error,
    });
    await appendCheckpointEventSafely(input.store, input.run.id, {
      type: "context_checkpoint.usage_record_failed",
      payload: {
        transcriptSeq: usage.transcriptSeq,
        version: usage.checkpointVersion,
        message: errorMessage(error),
      },
    });
  }
}

async function settleCheckpointUsageSafely(
  input: Parameters<typeof ensureContextCheckpoint>[0],
  usage: {
    reservation: UsageBudgetReservation | null;
    checkpointVersion: number;
    transcriptSeq: number;
    inputTokens: number;
    outputTokens: number;
    providerRequestStarted: boolean;
    usageObserved: boolean;
    latencyMs: number;
  },
): Promise<void> {
  try {
    await input.usage?.settle?.({
      reservation: usage.reservation,
      provider: input.providerName,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      providerRequestStarted: usage.providerRequestStarted,
      usageObserved: usage.usageObserved,
      latencyMs: usage.latencyMs,
    });
  } catch (error) {
    console.error("[context-checkpoint] usage settlement failed", {
      runId: input.run.id,
      transcriptSeq: usage.transcriptSeq,
      error,
    });
    await appendCheckpointEventSafely(input.store, input.run.id, {
      type: "context_checkpoint.usage_settlement_failed",
      payload: {
        transcriptSeq: usage.transcriptSeq,
        version: usage.checkpointVersion,
        message: errorMessage(error),
      },
    });
  }
}

async function appendCheckpointEventSafely(
  store: ContextCheckpointStore,
  runId: string,
  event: {
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await store.appendEvent({
      runId,
      type: event.type,
      payload: event.payload,
    });
  } catch (error) {
    // 诊断事件本身不是 Agent 的执行事实。数据库短暂故障时写 stderr 即可，
    // 不能因“记录失败”覆盖原始摘要结果或制造新的主流程异常。
    console.error("[context-checkpoint] diagnostic event append failed", {
      runId,
      type: event.type,
      error,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知摘要错误";
}

export function selectCheckpointTranscriptSeq(
  transcript: readonly TranscriptMessage[],
  currentCheckpointSeq: number,
  currentRunId: string,
): number {
  const candidates = transcript
    .filter((message) => (message.seq ?? 0) > currentCheckpointSeq)
    .toSorted((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  if (candidates.length === 0) {
    return currentCheckpointSeq;
  }

  const retentionStarts: number[] = [];
  const userMessages = candidates.filter(
    (message) => message.kind === "user_message",
  );
  const retainedUser =
    userMessages.length <= RETAINED_INTERACTION_GROUPS
      ? userMessages[0]
      : userMessages.at(-RETAINED_INTERACTION_GROUPS);
  if (retainedUser?.seq) {
    retentionStarts.push(retainedUser.seq);
  }

  const currentRunStart = candidates.find(
    (message) => message.runId === currentRunId,
  )?.seq;
  if (currentRunStart) {
    retentionStarts.push(currentRunStart);
  }

  const calls = new Map<string, TranscriptMessage>();
  const results = new Map<string, TranscriptMessage>();
  for (const message of candidates) {
    if (message.kind === "tool_call") {
      calls.set(message.toolCallId, message);
    } else if (message.kind === "tool_result") {
      results.set(message.toolCallId, message);
    }
  }
  for (const [toolCallId, call] of calls) {
    if (!results.has(toolCallId) && call.seq) {
      retentionStarts.push(call.seq);
    }
  }

  const latestFailedResult = candidates
    .filter(
      (message) =>
        message.kind === "tool_result" && message.resultJson.ok === false,
    )
    .at(-1);
  if (latestFailedResult?.kind === "tool_result") {
    const call = calls.get(latestFailedResult.toolCallId);
    retentionStarts.push(call?.seq ?? latestFailedResult.seq ?? 0);
  }

  const firstRetainedSeq =
    retentionStarts.filter((value) => value > 0).sort((a, b) => a - b)[0] ??
    (candidates.at(-1)?.seq ?? currentCheckpointSeq) + 1;
  let cutoff = firstRetainedSeq - 1;

  // 多个 Tool Call 可能在同一轮先全部发出、随后再返回结果。一次边界回退
  // 可能因此切进另一组调用区间，必须迭代到固定点，才能保证 Checkpoint
  // 最终不会拆散任何一组 call/result，也不依赖 Map 的插入顺序。
  let boundaryChanged = true;
  while (boundaryChanged) {
    boundaryChanged = false;
    for (const [toolCallId, call] of calls) {
      const result = results.get(toolCallId);
      if (
        call.seq &&
        result?.seq &&
        call.seq <= cutoff &&
        result.seq > cutoff
      ) {
        cutoff = call.seq - 1;
        boundaryChanged = true;
      }
    }
  }
  return Math.max(currentCheckpointSeq, cutoff);
}

function formatSummaryInput(
  previousSummary: string | null,
  messages: readonly TranscriptMessage[],
): string {
  const rows = messages.map((message) => {
    const prefix = `#${message.seq ?? "?"} run=${message.runId ?? "none"} ${message.kind}`;
    switch (message.kind) {
      case "user_message":
      case "assistant_message":
        return `${prefix}\n${message.content}`;
      case "tool_call":
        return `${prefix} ${message.toolName} ${JSON.stringify(message.argumentsJson)}`;
      case "tool_result":
        return `${prefix} ${message.toolName} ${JSON.stringify(message.resultJson)}`;
      case "system_event":
        return "";
    }
  });

  return [
    ...(previousSummary
      ? [`已有 Checkpoint 摘要（请合并更新）：\n${previousSummary}`]
      : []),
    `需要压缩的 Transcript：\n${rows.filter(Boolean).join("\n\n")}`,
  ].join("\n\n");
}
