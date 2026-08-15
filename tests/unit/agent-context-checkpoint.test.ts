import { describe, expect, it, vi } from "vitest";

import {
  ensureContextCheckpoint,
  selectCheckpointTranscriptSeq,
  type ContextCheckpointStore,
} from "@/domains/agent/context-checkpoint";
import type {
  LlmProvider,
  ProviderEvent,
  ProviderTurnInput,
} from "@/domains/agent/provider";
import {
  EMPTY_AGENT_RUN_USAGE,
  type AgentRunRecord,
  type ContextCheckpoint,
  type TranscriptMessage,
} from "@/domains/agent/types";

class SummaryProvider implements LlmProvider {
  readonly inputs: ProviderTurnInput[] = [];

  constructor(
    private readonly events: readonly ProviderEvent[] = [
      { type: "text_delta", text: "压缩后的历史摘要" },
      {
        type: "usage",
        inputTokens: 120,
        outputTokens: 18,
        totalTokens: 138,
      },
      { type: "finish", reason: "stop" },
    ],
    private readonly failure?: Error,
  ) {}

  async *streamTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    this.inputs.push(input);
    if (this.failure) {
      throw this.failure;
    }
    for (const event of this.events) {
      yield event;
    }
  }
}

class MemoryCheckpointStore implements ContextCheckpointStore {
  checkpoint: ContextCheckpoint = {
    summary: null,
    transcriptSeq: 0,
    version: 0,
    updatedAt: null,
  };
  readonly events: Array<{
    runId: string;
    type: string;
    payload: Record<string, unknown>;
  }> = [];
  compareAndSetCalls = 0;
  conflictWinner: ContextCheckpoint | null = null;
  failEvents = false;

  async getContextCheckpoint() {
    return this.checkpoint;
  }

  async compareAndSetContextCheckpoint(input: {
    expectedVersion: number;
    summary: string;
    transcriptSeq: number;
  }) {
    this.compareAndSetCalls += 1;
    if (this.conflictWinner) {
      this.checkpoint = this.conflictWinner;
      this.conflictWinner = null;
      return false;
    }
    if (input.expectedVersion !== this.checkpoint.version) {
      return false;
    }
    this.checkpoint = {
      summary: input.summary,
      transcriptSeq: input.transcriptSeq,
      version: this.checkpoint.version + 1,
      updatedAt: new Date(),
    };
    return true;
  }

  async appendEvent(input: {
    runId: string;
    type: string;
    payload: Record<string, unknown>;
  }) {
    if (this.failEvents) {
      throw new Error("event unavailable");
    }
    this.events.push(input);
  }
}

function createRun(id = "run-current"): AgentRunRecord {
  const now = new Date();
  return {
    id,
    conversationId: "conversation-1",
    projectId: "project-1",
    ownerId: "owner-1",
    status: "running",
    startRevision: 1,
    currentRevision: 1,
    locale: "zh-CN",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    promptProfile: "test-prompt",
    promptDigest: "prompt-digest",
    toolsetProfile: "test-tools",
    toolsetDigest: "tool-digest",
    modelProfile: "test-model",
    repositoryCapability: {
      storageKind: "database",
      canRead: true,
      canWrite: true,
      canExecuteServerTools: true,
    },
    budget: {
      maxModelTurns: null,
      maxWallTimeSeconds: 1_800,
      maxOutputCharacters: 24_000,
      maxToolResultCharacters: 20_000,
      maxFileMutations: 512,
      maxClientResumes: 32,
      maxNoProgressRepeats: 2,
    },
    usage: EMPTY_AGENT_RUN_USAGE,
    correlationId: "correlation-1",
    executionLeaseId: "lease-1",
    executionLeaseExpiresAt: new Date(now.getTime() + 60_000),
    cancellationRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function createConversationHistory(options?: {
  largeOlderPrefix?: boolean;
  runId?: string;
}): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = [];
  for (let index = 1; index <= 30; index += 1) {
    const seq = index * 2 - 1;
    const isOlderPrefix = index <= 6;
    const content =
      options?.largeOlderPrefix && isOlderPrefix
        ? `第 ${index} 组旧请求：${"上下文".repeat(4_000)}`
        : `第 ${index} 组请求`;
    transcript.push(
      {
        conversationId: "conversation-1",
        runId: options?.runId ?? `run-old-${index}`,
        seq,
        role: "user",
        kind: "user_message",
        content,
      },
      {
        conversationId: "conversation-1",
        runId: options?.runId ?? `run-old-${index}`,
        seq: seq + 1,
        role: "assistant",
        kind: "assistant_message",
        content: `第 ${index} 组回复`,
      },
    );
  }
  return transcript;
}

describe("ContextCheckpoint", () => {
  it("Provider 提供窗口信息时按 70% 阈值触发摘要", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();

    await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript: createConversationHistory(),
      systemPrompt: "system",
      // 普通历史不足 96k，但超过这个测试窗口的 70%，可证明阈值来自
      // Provider 元数据，而不是继续使用固定常量。
      maxContextCharacters: 500,
    });

    expect(provider.inputs).toHaveLength(1);
    expect(store.checkpoint.version).toBe(1);
  });

  it("上下文未达到阈值时不调用摘要模型", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();

    const checkpoint = await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript: createConversationHistory(),
      systemPrompt: "system",
    });

    expect(checkpoint).toEqual(store.checkpoint);
    expect(provider.inputs).toHaveLength(0);
    expect(store.compareAndSetCalls).toBe(0);
  });

  it("没有可靠窗口信息时保留 96k 字符兜底", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();

    await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript: createConversationHistory(),
      systemPrompt: "system",
      maxContextCharacters: Number.NaN,
    });

    expect(provider.inputs).toHaveLength(0);
    expect(store.compareAndSetCalls).toBe(0);
  });

  it("压缩旧前缀并通过 CAS 持久化，但不修改原始 Transcript", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();
    const transcript = createConversationHistory({ largeOlderPrefix: true });
    const originalTranscript = structuredClone(transcript);

    const checkpoint = await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript,
      systemPrompt: "system",
    });

    expect(checkpoint).toMatchObject({
      summary: "压缩后的历史摘要",
      transcriptSeq: 12,
      version: 1,
    });
    expect(transcript).toEqual(originalTranscript);
    expect(provider.inputs).toHaveLength(1);
    expect(store.events.at(-1)).toMatchObject({
      type: "context_checkpoint.completed",
      payload: { transcriptSeq: 12, version: 1 },
    });
  });

  it("CAS 冲突后采用赢家版本，剩余上下文足够小时不重复摘要", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();
    store.conflictWinner = {
      summary: "另一个 Run 已提交的摘要",
      transcriptSeq: 12,
      version: 1,
      updatedAt: new Date(),
    };

    const checkpoint = await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript: createConversationHistory({ largeOlderPrefix: true }),
      systemPrompt: "system",
    });

    expect(checkpoint).toMatchObject({
      summary: "另一个 Run 已提交的摘要",
      transcriptSeq: 12,
      version: 1,
    });
    expect(provider.inputs).toHaveLength(1);
    expect(store.compareAndSetCalls).toBe(1);
    expect(
      store.events.some(
        (event) => event.type === "context_checkpoint.cas_conflicted",
      ),
    ).toBe(true);
  });

  it("两个 Run 并发生成同一摘要时只有 Claim 持有者调用 Provider", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();
    const reserve = vi
      .fn()
      .mockResolvedValueOnce({
        idempotencyKey: "context-checkpoint:shared",
        bucketDate: "2026-08-15",
        reservedCostUsd: "0.001",
        acquired: true,
        claimId: "claim-owner",
        claimExpiresAt: "2026-08-15T12:10:00.000Z",
        alreadySettled: false,
      })
      .mockResolvedValueOnce({
        idempotencyKey: "context-checkpoint:shared",
        bucketDate: "2026-08-15",
        reservedCostUsd: "0.001",
        acquired: false,
        alreadySettled: false,
      });
    const settle = vi.fn().mockResolvedValue(undefined);
    const transcript = createConversationHistory({ largeOlderPrefix: true });

    const [first, second] = await Promise.all([
      ensureContextCheckpoint({
        store,
        provider,
        providerName: "deepseek",
        model: "deepseek-v4-flash",
        run: createRun("run-concurrent-1"),
        transcript,
        systemPrompt: "system",
        usage: { reserve, settle },
      }),
      ensureContextCheckpoint({
        store,
        provider,
        providerName: "deepseek",
        model: "deepseek-v4-flash",
        run: createRun("run-concurrent-2"),
        transcript,
        systemPrompt: "system",
        usage: { reserve, settle },
      }),
    ]);

    expect([first.version, second.version].sort()).toEqual([0, 1]);
    expect(store.checkpoint).toMatchObject({
      transcriptSeq: 12,
      version: 1,
    });
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(store.compareAndSetCalls).toBe(1);
    expect(provider.inputs).toHaveLength(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(
      store.events.filter(
        (event) => event.type === "context_checkpoint.completed",
      ),
    ).toHaveLength(1);
    expect(
      store.events.filter(
        (event) => event.type === "context_checkpoint.retry_suppressed",
      ),
    ).toHaveLength(1);
  });

  it("摘要 Provider 失败时返回最后可靠版本，不阻断主 Agent", async () => {
    const provider = new SummaryProvider([], new Error("summary unavailable"));
    const store = new MemoryCheckpointStore();

    await expect(
      ensureContextCheckpoint({
        store,
        provider,
        providerName: "deepseek",
        model: "deepseek-v4-flash",
        run: createRun(),
        transcript: createConversationHistory({ largeOlderPrefix: true }),
        systemPrompt: "system",
      }),
    ).resolves.toEqual(store.checkpoint);
    expect(store.events.at(-1)).toMatchObject({
      type: "context_checkpoint.failed",
      payload: { message: "summary unavailable" },
    });
  });

  it("同一 Run 的同一摘要边界已经结算后不再次调用 Provider", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();
    const settle = vi.fn().mockResolvedValue(undefined);
    const reserve = vi.fn().mockResolvedValue({
      idempotencyKey: "context-checkpoint:existing",
      bucketDate: "2026-08-15",
      reservedCostUsd: "0",
      acquired: false,
      alreadySettled: true,
    });

    const checkpoint = await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript: createConversationHistory({ largeOlderPrefix: true }),
      systemPrompt: "system",
      usage: { reserve, settle },
    });

    expect(checkpoint).toEqual(store.checkpoint);
    expect(provider.inputs).toHaveLength(0);
    expect(settle).not.toHaveBeenCalled();
    expect(store.events.at(-1)).toMatchObject({
      type: "context_checkpoint.retry_suppressed",
      payload: { transcriptSeq: 12, version: 0 },
    });
  });

  it("streamTurn 同步构造失败时按 Provider 未启动释放 reservation", async () => {
    const provider: LlmProvider = {
      streamTurn() {
        throw new Error("stream construction failed");
      },
    };
    const store = new MemoryCheckpointStore();
    const settle = vi.fn().mockResolvedValue(undefined);
    const reserve = vi.fn().mockResolvedValue({
      idempotencyKey: "context-checkpoint:released",
      bucketDate: "2026-08-15",
      reservedCostUsd: "0.001",
      acquired: true,
      alreadySettled: false,
    });

    await expect(
      ensureContextCheckpoint({
        store,
        provider,
        providerName: "deepseek",
        model: "deepseek-v4-flash",
        run: createRun(),
        transcript: createConversationHistory({ largeOlderPrefix: true }),
        systemPrompt: "system",
        usage: { reserve, settle },
      }),
    ).resolves.toEqual(store.checkpoint);

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRequestStarted: false,
        usageObserved: false,
      }),
    );
  });

  it("Usage 或诊断事件写入失败不回滚已经成功的 Checkpoint", async () => {
    const provider = new SummaryProvider();
    const store = new MemoryCheckpointStore();
    store.failEvents = true;
    const record = vi.fn().mockRejectedValue(new Error("usage unavailable"));

    const checkpoint = await ensureContextCheckpoint({
      store,
      provider,
      providerName: "deepseek",
      model: "deepseek-v4-flash",
      run: createRun(),
      transcript: createConversationHistory({ largeOlderPrefix: true }),
      systemPrompt: "system",
      usage: { record },
    });

    expect(checkpoint).toMatchObject({
      summary: "压缩后的历史摘要",
      transcriptSeq: 12,
      version: 1,
    });
    expect(record).toHaveBeenCalledOnce();
    expect(store.checkpoint).toMatchObject({ version: 1 });
  });

  it("保留最近 24 组交互以及当前 Run 的全部消息", () => {
    const history = createConversationHistory();
    expect(selectCheckpointTranscriptSeq(history, 0, "run-current")).toBe(12);

    const currentRunHistory = createConversationHistory({
      runId: "run-current",
    });
    expect(
      selectCheckpointTranscriptSeq(currentRunHistory, 0, "run-current"),
    ).toBe(0);
  });

  it("不拆散工具调用，并保留未闭合和最近失败的工具记录", () => {
    // 将基础会话序号放大，给额外工具记录预留唯一 seq，避免重复序号让
    // 边界排序依赖插入顺序，掩盖真正的 tool_call/tool_result 配对逻辑。
    const base = createConversationHistory().map((message) => ({
      ...message,
      seq: (message.seq ?? 0) * 100,
    }));
    const withCrossingPair: TranscriptMessage[] = [
      ...base,
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 950,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-crossing",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 1_350,
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-crossing",
        toolName: "read_file",
        resultJson: { ok: true },
      },
    ];
    expect(
      selectCheckpointTranscriptSeq(withCrossingPair, 0, "run-current"),
    ).toBe(949);

    const withOverlappingPairs: TranscriptMessage[] = [
      ...base,
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 900,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-overlap-1",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 950,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-overlap-2",
        toolName: "read_file",
        argumentsJson: { path: "src/main.tsx" },
      },
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 1_000,
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-overlap-1",
        toolName: "read_file",
        resultJson: { ok: true },
      },
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 1_350,
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-overlap-2",
        toolName: "read_file",
        resultJson: { ok: true },
      },
    ];
    expect(
      selectCheckpointTranscriptSeq(withOverlappingPairs, 0, "run-current"),
    ).toBe(899);

    const withOpenCall: TranscriptMessage[] = [
      ...base,
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 850,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-open",
        toolName: "write_file",
        argumentsJson: { path: "src/App.tsx" },
      },
    ];
    expect(selectCheckpointTranscriptSeq(withOpenCall, 0, "run-current")).toBe(
      849,
    );

    const withFailedTool: TranscriptMessage[] = [
      ...base,
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 650,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-failed",
        toolName: "write_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation-1",
        runId: "run-old-tool",
        seq: 651,
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-failed",
        toolName: "write_file",
        resultJson: { ok: false, error: "revision conflict" },
      },
    ];
    expect(
      selectCheckpointTranscriptSeq(withFailedTool, 0, "run-current"),
    ).toBe(649);
  });
});
