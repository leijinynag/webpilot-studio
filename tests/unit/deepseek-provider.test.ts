// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import { DeepSeekProvider } from "@/infrastructure/agent/deepseek-provider";

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("DeepSeekProvider", () => {
  it("parses chunked SSE text, tool calls, usage and keep-alives", async () => {
    const fetchImplementation = vi.fn(async () =>
      streamResponse([
        ": keep-alive\n\n",
        'data: {"choices":[{"index":0,"delta":{"content":"完成","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\n',
        '\ndata: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"src/App.tsx\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      fetchImplementation,
    });
    const events = [];

    for await (const event of provider.streamTurn({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "修改页面" }],
      tools: [],
      maxOutputTokens: 1024,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "完成" },
      {
        type: "tool_call_delta",
        index: 0,
        toolCallId: "call-1",
        toolName: "write_file",
        argumentsDelta: '{"path":',
      },
      {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: '"src/App.tsx"}',
      },
      { type: "finish", reason: "tool_calls" },
      {
        type: "usage",
        inputTokens: 12,
        outputTokens: 7,
        totalTokens: 19,
      },
    ]);
  });

  it("maps HTTP 429 to a stable rate-limit error", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      fetchImplementation: vi.fn(
        async () => new Response("busy", { status: 429 }),
      ),
    });

    await expect(async () => {
      for await (const event of provider.streamTurn({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        maxOutputTokens: 128,
      })) {
        // 消费生成器才能触发真实请求。
        void event;
      }
    }).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.providerRateLimited,
    });
  });

  it("rejects a stream that ends without [DONE]", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      fetchImplementation: vi.fn(async () =>
        streamResponse([
          'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        ]),
      ),
    });

    await expect(async () => {
      for await (const event of provider.streamTurn({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        maxOutputTokens: 128,
      })) {
        // 消费生成器直到异常终止。
        void event;
      }
    }).rejects.toMatchObject({
      code: AGENT_ERROR_CODES.providerInterrupted,
    });
  });
});
