import { z } from "zod";

import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type {
  LlmProvider,
  ProviderEvent,
  ProviderFinishReason,
  ProviderTurnInput,
} from "@/domains/agent/provider";
import type { ProviderMessage } from "@/domains/agent/types";

const deepSeekToolCallDeltaSchema = z
  .object({
    index: z.number().int().nonnegative(),
    id: z.string().optional(),
    type: z.literal("function").optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const deepSeekChunkSchema = z
  .object({
    choices: z.array(
      z
        .object({
          index: z.number().int(),
          delta: z
            .object({
              content: z.string().nullable().optional(),
              tool_calls: z.array(deepSeekToolCallDeltaSchema).optional(),
            })
            .passthrough(),
          finish_reason: z.string().nullable(),
        })
        .passthrough(),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

type FetchLike = typeof fetch;

export type DeepSeekProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImplementation?: FetchLike;
};

export class DeepSeekProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchLike;

  constructor(private readonly options: DeepSeekProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async *streamTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = combineAbortSignals(input.signal, timeoutController.signal);

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages.map(toDeepSeekMessage),
            tools: input.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: input.tools.length > 0 ? "auto" : "none",
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: input.maxOutputTokens,
            temperature: 0.2,
            thinking: { type: "disabled" },
            ...(input.userId ? { user_id: normalizeUserId(input.userId) } : {}),
          }),
          signal,
        },
      );

      if (!response.ok) {
        throw await toProviderHttpError(response);
      }

      if (!response.body) {
        throw invalidStreamError("DeepSeek 响应缺少可读取的 stream body。");
      }

      let sawDone = false;
      for await (const data of readSseData(response.body)) {
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }

        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(data);
        } catch {
          throw invalidStreamError("DeepSeek SSE 包含非法 JSON。");
        }

        const parsed = deepSeekChunkSchema.safeParse(parsedJson);
        if (!parsed.success) {
          throw invalidStreamError("DeepSeek SSE chunk 结构不合法。", {
            issues: parsed.error.issues,
          });
        }

        for (const choice of parsed.data.choices) {
          if (choice.index !== 0) {
            continue;
          }

          if (choice.delta.content) {
            yield { type: "text_delta", text: choice.delta.content };
          }

          for (const toolCall of choice.delta.tool_calls ?? []) {
            yield {
              type: "tool_call_delta",
              index: toolCall.index,
              ...(toolCall.id ? { toolCallId: toolCall.id } : {}),
              ...(toolCall.function?.name
                ? { toolName: toolCall.function.name }
                : {}),
              ...(toolCall.function?.arguments
                ? { argumentsDelta: toolCall.function.arguments }
                : {}),
            };
          }

          if (choice.finish_reason) {
            yield {
              type: "finish",
              reason: mapFinishReason(choice.finish_reason),
            };
          }
        }

        if (parsed.data.usage) {
          yield {
            type: "usage",
            inputTokens: parsed.data.usage.prompt_tokens,
            outputTokens: parsed.data.usage.completion_tokens,
            totalTokens: parsed.data.usage.total_tokens,
          };
        }
      }

      if (!sawDone) {
        throw new AgentError(
          AGENT_ERROR_CODES.providerInterrupted,
          "DeepSeek 流在 [DONE] 之前结束。",
          502,
        );
      }
    } catch (error) {
      if (error instanceof AgentError) {
        throw error;
      }

      if (signal.aborted) {
        if (input.signal?.aborted) {
          throw new AgentError(
            AGENT_ERROR_CODES.providerInterrupted,
            "DeepSeek 调用已被取消。",
            499,
          );
        }

        throw new AgentError(
          AGENT_ERROR_CODES.providerTimeout,
          "DeepSeek 调用超时。",
          504,
        );
      }

      throw new AgentError(
        AGENT_ERROR_CODES.providerInterrupted,
        "DeepSeek 连接异常中断。",
        502,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toDeepSeekMessage(message: ProviderMessage) {
  if (message.role !== "assistant" || !message.toolCalls) {
    return message;
  }

  return {
    role: "assistant" as const,
    content: message.content,
    tool_calls: message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function" as const,
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsJson,
      },
    })),
  };
}

async function* readSseData(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");

      if (data) {
        yield data;
      }

      boundary = buffer.indexOf("\n\n");
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    const data = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (data) {
      yield data;
    }
  }
}

async function toProviderHttpError(response: Response): Promise<AgentError> {
  const details = await response.text().catch(() => "");

  if (response.status === 429) {
    return new AgentError(
      AGENT_ERROR_CODES.providerRateLimited,
      "DeepSeek 请求达到并发或速率限制。",
      429,
      { providerStatus: response.status, providerBody: details.slice(0, 1000) },
    );
  }

  return new AgentError(
    AGENT_ERROR_CODES.providerInterrupted,
    `DeepSeek 请求失败（HTTP ${response.status}）。`,
    response.status >= 500 ? 502 : 400,
    { providerStatus: response.status, providerBody: details.slice(0, 1000) },
  );
}

function mapFinishReason(reason: string): ProviderFinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return reason;
    default:
      return "provider_interrupted";
  }
}

function invalidStreamError(
  message: string,
  details?: Record<string, unknown>,
): AgentError {
  return new AgentError(
    AGENT_ERROR_CODES.providerInvalidStream,
    message,
    502,
    details,
  );
}

function normalizeUserId(value: string): string {
  return value.replace(/[^a-zA-Z0-9\-_]/g, "_").slice(0, 512);
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  if (!first) {
    return second;
  }

  return AbortSignal.any([first, second]);
}
