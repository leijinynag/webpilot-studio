// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodeCompletionResponse } from "@/domains/code-completion/types";
import {
  createCodeCompletionClient,
  type CodeCompletionClientInput,
  type CodeCompletionMetric,
} from "@/infrastructure/code-completion/client";

const projectId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

describe("CodeCompletionClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("自动触发等待 350ms，显式触发则立即请求", async () => {
    // Response body 只能消费一次；每次请求都创建独立响应，贴近真实 fetch 行为，
    // 避免测试桩复用同一个 body 后把第二次调用误判为客户端解析失败。
    const fetcher = vi.fn(() => Promise.resolve(createResponse()));
    const client = createCodeCompletionClient({
      fetcher,
      createRequestId: () => requestId,
    });

    const automatic = client.request(createInput());
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(349);
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(automatic).resolves.toMatchObject({
      response: { insertText: "answer" },
    });
    expect(fetcher).toHaveBeenCalledOnce();

    const explicit = client.request(
      createInput({
        prefix: "const explicit = ",
        trigger: "explicit",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await expect(explicit).resolves.toMatchObject({
      response: { insertText: "answer" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it("新输入会取消旧的防抖请求，并记录 superseded 指标", async () => {
    const metrics: CodeCompletionMetric[] = [];
    const fetcher = vi.fn().mockResolvedValue(createResponse());
    const client = createCodeCompletionClient({
      fetcher,
      metrics: (metric) => metrics.push(metric),
      createRequestId: () => requestId,
    });

    const first = client.request(createInput({ prefix: "const a = " }));
    const second = client.request(createInput({ prefix: "const ab = " }));

    await expect(first).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(350);
    await expect(second).resolves.not.toBeNull();

    expect(fetcher).toHaveBeenCalledOnce();
    expect(metrics).toContainEqual(
      expect.objectContaining({
        name: "cancelled",
        reason: "superseded",
      }),
    );
    client.dispose();
  });

  it("完全相同的进行中请求复用同一个 Promise", async () => {
    let resolveFetch: (response: Response) => void = () => {
      throw new Error("fetch resolver 尚未初始化。");
    };
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = createCodeCompletionClient({
      fetcher,
      automaticDebounceMs: 0,
      createRequestId: () => requestId,
    });
    const input = createInput();

    const first = client.request(input);
    const duplicate = client.request(input);
    expect(duplicate).toBe(first);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    resolveFetch(createResponse());
    await expect(first).resolves.not.toBeNull();
    client.dispose();
  });

  it("后续请求提升 generation，旧结果不再具有插入资格", async () => {
    const fetcher = vi.fn(() => Promise.resolve(createResponse()));
    let sequence = 0;
    const client = createCodeCompletionClient({
      fetcher,
      automaticDebounceMs: 0,
      createRequestId: () =>
        sequence++ === 0 ? requestId : "33333333-3333-4333-8333-333333333333",
    });

    const first = await client.request(createInput());
    expect(first).not.toBeNull();
    expect(client.isCurrent(first!.generation)).toBe(true);

    const second = await client.request(
      createInput({ prefix: "const newer = " }),
    );
    expect(second).not.toBeNull();
    expect(client.isCurrent(first!.generation)).toBe(false);
    expect(client.isCurrent(second!.generation)).toBe(true);
    client.dispose();
  });

  it("记录请求、首结果与服务端缓存命中指标", async () => {
    const metrics: CodeCompletionMetric[] = [];
    const fetcher = vi
      .fn()
      .mockResolvedValue(createResponse({ cacheHit: true }));
    const client = createCodeCompletionClient({
      fetcher,
      metrics: (metric) => metrics.push(metric),
      automaticDebounceMs: 0,
      createRequestId: () => requestId,
    });

    await client.request(createInput());

    expect(metrics.map((metric) => metric.name)).toEqual([
      "request",
      "first_result",
      "cache_hit",
    ]);
    expect(metrics[1]).toMatchObject({
      latencyMs: 28,
      value: 19,
      model: "deepseek-v4-flash",
    });
    client.dispose();
  });
});

function createInput(
  overrides: Partial<CodeCompletionClientInput> = {},
): CodeCompletionClientInput {
  return {
    projectId,
    projectRevision: 7,
    path: "src/App.tsx",
    language: "typescript",
    position: { lineNumber: 1, column: 15 },
    prefix: "const value = ",
    suffix: "",
    trigger: "automatic",
    ...overrides,
  };
}

function createResponse(
  overrides: Partial<CodeCompletionResponse> = {},
): Response {
  return Response.json({
    requestId,
    projectRevision: 7,
    insertText: "answer",
    model: "deepseek-v4-flash",
    latencyMs: 28,
    firstResultLatencyMs: 19,
    cacheHit: false,
    ...overrides,
  } satisfies CodeCompletionResponse);
}
