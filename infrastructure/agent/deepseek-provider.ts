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
  /** DeepSeek 专属 thinking 参数，其他 OpenAI-compatible Provider 不发送。 */
  includeThinking?: boolean;
  timeoutMs?: number;
  firstEventTimeoutMs?: number;
  streamInactivityTimeoutMs?: number;
  finishTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  fetchImplementation?: FetchLike;
};

export class DeepSeekProvider implements LlmProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly firstEventTimeoutMs: number;
  private readonly streamInactivityTimeoutMs: number;
  private readonly finishTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImplementation: FetchLike;

  constructor(private readonly options: DeepSeekProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.firstEventTimeoutMs = options.firstEventTimeoutMs ?? 15_000;
    this.streamInactivityTimeoutMs =
      options.streamInactivityTimeoutMs ?? 12_000;
    this.finishTimeoutMs = options.finishTimeoutMs ?? 3_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 500);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async *streamTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let emittedEvent = false;

      try {
        for await (const event of this.streamAttempt(input)) {
          emittedEvent = true;
          yield event;
        }
        return;
      } catch (error) {
        const canRetry =
          !emittedEvent &&
          attempt < this.maxAttempts &&
          isRetryablePreStreamError(error) &&
          !input.signal?.aborted;

        if (!canRetry) {
          throw error;
        }

        // 只有模型尚未返回任何事件时才能重试。流一旦开始，重放请求可能产生
        // 重复文本或重复工具调用，因此必须把中断交给上层作为失败处理。
        await waitForRetry(
          this.retryBaseDelayMs * 2 ** (attempt - 1),
          input.signal,
        );
      }
    }
  }

  private async *streamAttempt(
    input: ProviderTurnInput,
  ): AsyncIterable<ProviderEvent> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const signal = combineAbortSignals(input.signal, timeoutController.signal);
    let sawFinish = false;

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
            ...(this.options.includeThinking === false
              ? {}
              : { thinking: { type: "disabled" } }),
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
      let sawProviderData = false;
      try {
        for await (const data of readSseData(response.body, {
          getTimeout: () => {
            if (sawFinish) {
              return {
                timeoutMs: this.finishTimeoutMs,
                phase: "finish",
              };
            }

            if (sawProviderData) {
              return {
                timeoutMs: this.streamInactivityTimeoutMs,
                phase: "stream",
              };
            }

            return {
              timeoutMs: this.firstEventTimeoutMs,
              phase: "first_event",
            };
          },
        })) {
          sawProviderData = true;

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
              sawFinish = true;
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
      } catch (error) {
        if (!sawFinish || !isFinishTailTimeout(error)) {
          throw error;
        }

        // DeepSeek 的 OpenAI 兼容流偶尔在 finish_reason 与 usage 后既不发送
        // [DONE]，也不主动关闭连接。finish_reason 已经封闭当前 choice，短暂
        // 等待尾帧超时后可以安全结束；工具参数完整性仍由领域层严格校验。
      }

      if (!sawDone && !sawFinish) {
        throw new AgentError(
          AGENT_ERROR_CODES.providerInterrupted,
          "DeepSeek 流在 finish_reason 或 [DONE] 之前结束。",
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

function isFinishTailTimeout(error: unknown): boolean {
  return (
    error instanceof AgentError &&
    error.code === AGENT_ERROR_CODES.providerTimeout &&
    error.details?.phase === "finish"
  );
}

function isRetryablePreStreamError(error: unknown): boolean {
  return (
    error instanceof AgentError &&
    (error.code === AGENT_ERROR_CODES.providerInterrupted ||
      error.code === AGENT_ERROR_CODES.providerTimeout)
  );
}

async function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    function handleAbort() {
      clearTimeout(timeout);
      reject(
        new AgentError(
          AGENT_ERROR_CODES.providerInterrupted,
          "DeepSeek 调用已被取消。",
          499,
        ),
      );
    }

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function toDeepSeekMessage(message: ProviderMessage) {
  if (message.role === "tool") {
    // 领域层保持供应商无关的 camelCase；DeepSeek 的 OpenAI 兼容协议
    // 要求工具结果使用 tool_call_id，否则第二轮请求会直接返回 HTTP 400。
    return {
      role: "tool" as const,
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }

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
  options: {
    getTimeout: () => {
      timeoutMs: number;
      phase: "first_event" | "stream" | "finish";
    };
  },
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { timeoutMs, phase } = options.getTimeout();
      const { done, value } = await readStreamChunkWithTimeout(
        reader,
        timeoutMs,
        phase,
      );
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
  } finally {
    reader.releaseLock();
  }
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  phase: "first_event" | "stream" | "finish",
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const timeoutError = new AgentError(
            AGENT_ERROR_CODES.providerTimeout,
            getStreamTimeoutMessage(phase),
            504,
            { phase, timeoutMs },
          );

          // 必须先让超时 Promise 进入 rejected 状态，再取消底层 reader。
          // 若先 cancel，未完成的 reader.read() 可能先以 done=true 结束，
          // 上层就会把真正的“静默超时”误判为普通 EOF 中断。
          reject(timeoutError);
          void reader.cancel("DeepSeek stream inactivity timeout");
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function getStreamTimeoutMessage(
  phase: "first_event" | "stream" | "finish",
): string {
  switch (phase) {
    case "first_event":
      return "DeepSeek 长时间未返回首个流事件。";
    case "stream":
      return "DeepSeek 流已开始，但长时间没有返回新数据。";
    case "finish":
      return "DeepSeek 已声明当前轮次结束，但未及时关闭响应流。";
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
