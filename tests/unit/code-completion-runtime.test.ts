// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { ProviderEvent } from "@/domains/agent/provider";
import type { AgentProviderRuntime } from "@/infrastructure/agent/provider-runtime-config";
import {
  recordCodeCompletionUsage,
  reserveCodeCompletionUsageBudget,
  settleCodeCompletionUsageBudget,
  type UsageBudgetReservation,
} from "@/infrastructure/quota/service";
import { createCodeCompletionRuntime } from "@/infrastructure/code-completion/runtime";

vi.mock("server-only", () => ({}));

const firstRequestId = "11111111-1111-4111-8111-111111111111";
const secondRequestId = "22222222-2222-4222-8222-222222222222";

const baseRequest = {
  projectRevision: 4,
  path: "src/App.tsx",
  language: "typescript" as const,
  position: { lineNumber: 3, column: 20 },
  prefix: "const value = ",
  suffix: "\nexport default value;",
  trigger: "automatic" as const,
};

function createUsageMocks() {
  return {
    record: vi.fn(async (): Promise<void> => undefined) as ReturnType<
      typeof vi.fn<typeof recordCodeCompletionUsage>
    >,
    reserve: vi.fn(
      async (): Promise<UsageBudgetReservation | null> => null,
    ) as ReturnType<typeof vi.fn<typeof reserveCodeCompletionUsageBudget>>,
    settle: vi.fn(async (): Promise<void> => undefined) as ReturnType<
      typeof vi.fn<typeof settleCodeCompletionUsageBudget>
    >,
  };
}

function createProvider(
  streamFactory: (
    signal: AbortSignal | undefined,
  ) => AsyncIterable<ProviderEvent>,
) {
  const streamTurn = vi.fn(({ signal }: { signal?: AbortSignal }) =>
    streamFactory(signal),
  );

  return {
    providerRuntime: {
      providerName: "deepseek" as const,
      model: "deepseek-v4-flash",
      provider: { streamTurn },
    } as AgentProviderRuntime,
    streamTurn,
  };
}

function request(clientRequestId = firstRequestId) {
  return {
    ...baseRequest,
    clientRequestId,
  };
}

async function* events(
  chunks: readonly ProviderEvent[],
): AsyncIterable<ProviderEvent> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("code completion runtime", () => {
  it("聚合流式文本、记录 usage，并且不产生 Agent 副作用", async () => {
    const usage = createUsageMocks();
    const { providerRuntime } = createProvider(() =>
      events([
        { type: "text_delta", text: "foo" },
        { type: "text_delta", text: "()" },
        {
          type: "usage",
          inputTokens: 120,
          outputTokens: 3,
          totalTokens: 123,
        },
        { type: "finish", reason: "stop" },
      ]),
    );
    const runtime = createCodeCompletionRuntime({
      providerRuntime,
      usage,
      now: () => 1_000,
    });

    const response = await runtime.complete({
      ownerId: "owner-1",
      request: request(),
    });

    expect(response).toMatchObject({
      requestId: firstRequestId,
      projectRevision: 4,
      insertText: "foo()",
      cacheHit: false,
      firstResultLatencyMs: 0,
    });
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        inputTokens: 120,
        outputTokens: 3,
        projectRevision: 4,
      }),
    );
    expect(usage.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRequestStarted: true,
        usageObserved: true,
      }),
    );
  });

  it("revision 已过期时直接返回，不调用 Provider", async () => {
    const usage = createUsageMocks();
    const { providerRuntime, streamTurn } = createProvider(() =>
      events([{ type: "text_delta", text: "never" }]),
    );
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });

    const response = await runtime.complete({
      ownerId: "owner-1",
      request: request(),
      currentProjectRevision: 5,
    });

    expect(response.reason).toBe("stale_revision");
    expect(response.insertText).toBe("");
    expect(streamTurn).not.toHaveBeenCalled();
    expect(usage.reserve).not.toHaveBeenCalled();
  });

  it("成功结果进入短期 LRU 缓存，后续请求不重复调用模型", async () => {
    const usage = createUsageMocks();
    const { providerRuntime, streamTurn } = createProvider(() =>
      events([{ type: "text_delta", text: "cached" }]),
    );
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });

    const first = await runtime.complete({
      ownerId: "owner-1",
      request: request(),
    });
    const second = await runtime.complete({
      ownerId: "owner-1",
      request: request(secondRequestId),
    });

    expect(first.insertText).toBe("cached");
    expect(second).toMatchObject({
      requestId: secondRequestId,
      insertText: "cached",
      cacheHit: true,
      latencyMs: 0,
    });
    expect(streamTurn).toHaveBeenCalledTimes(1);
  });

  it("相同语义请求共享一次 Provider 调用，等待者使用自己的 requestId", async () => {
    const usage = createUsageMocks();
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let providerStarted: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const { providerRuntime, streamTurn } = createProvider(() =>
      (async function* () {
        providerStarted?.();
        yield { type: "text_delta", text: "shared" };
        await gate;
      })(),
    );
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });

    const firstPromise = runtime.complete({
      ownerId: "owner-1",
      request: request(),
    });
    await providerStartedPromise;
    const secondPromise = runtime.complete({
      ownerId: "owner-1",
      request: request(secondRequestId),
    });

    resolveGate?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toMatchObject({
      requestId: firstRequestId,
      insertText: "shared",
      cacheHit: false,
    });
    expect(second).toMatchObject({
      requestId: secondRequestId,
      insertText: "shared",
      cacheHit: true,
    });
    expect(streamTurn).toHaveBeenCalledTimes(1);
  });

  it("单个等待者取消时不会中止仍在等待的共享请求", async () => {
    const usage = createUsageMocks();
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    let providerStarted: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const { providerRuntime } = createProvider((signal) =>
      (async function* () {
        providerSignal = signal;
        providerStarted?.();
        yield { type: "text_delta", text: "survives" };
        await gate;
      })(),
    );
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });
    const firstController = new AbortController();

    const firstPromise = runtime.complete({
      ownerId: "owner-1",
      request: request(),
      signal: firstController.signal,
    });
    await providerStartedPromise;
    const secondPromise = runtime.complete({
      ownerId: "owner-1",
      request: request(secondRequestId),
    });

    firstController.abort();
    await expect(firstPromise).rejects.toMatchObject({ status: 499 });
    expect(providerSignal?.aborted).toBe(false);

    resolveGate?.();
    await expect(secondPromise).resolves.toMatchObject({
      requestId: secondRequestId,
      insertText: "survives",
    });
  });

  it("所有等待者取消后才中止 Provider，并且不会产生未处理拒绝", async () => {
    const usage = createUsageMocks();
    let providerSignal: AbortSignal | undefined;
    let providerStarted: (() => void) | undefined;
    const providerStartedPromise = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const { providerRuntime } = createProvider((signal) =>
      (async function* () {
        providerSignal = signal;
        providerStarted?.();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("provider aborted");
      })(),
    );
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const firstPromise = runtime.complete({
      ownerId: "owner-1",
      request: request(),
      signal: firstController.signal,
    });
    await providerStartedPromise;
    const secondPromise = runtime.complete({
      ownerId: "owner-1",
      request: request(secondRequestId),
      signal: secondController.signal,
    });

    firstController.abort();
    secondController.abort();

    await expect(firstPromise).rejects.toMatchObject({ status: 499 });
    await expect(secondPromise).rejects.toMatchObject({ status: 499 });
    expect(providerSignal?.aborted).toBe(true);
  });

  it("Provider 失败时返回可诊断的空结果，并结算已取得的预算 reservation", async () => {
    const usage = createUsageMocks();
    const reservation: UsageBudgetReservation = {
      idempotencyKey: "completion-claim",
      bucketDate: "2026-08-15",
      reservedCostUsd: "0.01",
      acquired: true,
      claimId: "claim-1",
      alreadySettled: false,
    };
    usage.reserve.mockResolvedValue(reservation);
    const { providerRuntime } = createProvider(async function* () {
      throw new Error("provider unavailable");
    });
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });

    const response = await runtime.complete({
      ownerId: "owner-1",
      request: request(),
    });

    expect(response).toMatchObject({
      insertText: "",
      reason: "completion_failed",
    });
    expect(usage.record).not.toHaveBeenCalled();
    expect(usage.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation,
        providerRequestStarted: true,
        usageObserved: false,
      }),
    );
  });

  it("模型返回空文本时不写入缓存，下一次请求仍可重试", async () => {
    const usage = createUsageMocks();
    const { providerRuntime, streamTurn } = createProvider(() => events([]));
    const runtime = createCodeCompletionRuntime({ providerRuntime, usage });

    const first = await runtime.complete({
      ownerId: "owner-1",
      request: request(),
    });
    const second = await runtime.complete({
      ownerId: "owner-1",
      request: request(secondRequestId),
    });

    expect(first.reason).toBe("no_suggestion");
    expect(second.reason).toBe("no_suggestion");
    expect(second.cacheHit).toBe(false);
    expect(streamTurn).toHaveBeenCalledTimes(2);
  });
});
