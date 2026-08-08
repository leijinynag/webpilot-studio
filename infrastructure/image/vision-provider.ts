import { z } from "zod";

import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import type { VisionProvider } from "@/domains/image/vision";
import { parseVisionJsonContent } from "@/domains/image/vision-summary";

const responseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.string().nullable(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

type FetchLike = typeof fetch;

export type OpenAiCompatibleVisionProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImplementation?: FetchLike;
};

/**
 * 使用 OpenAI-compatible Chat Completions 传递图片。
 *
 * 这里刻意只实现一次非流式请求。Vision 是 Agent 的观察工具，不应把半截
 * 描述写进事实记录；要么拿到完整且通过 schema 校验的摘要，要么返回稳定错误。
 */
export class OpenAiCompatibleVisionProvider implements VisionProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchLike;

  constructor(private readonly options: OpenAiCompatibleVisionProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    // 图片理解通常比文本 Agent 慢，尤其是带推理过程的视觉模型。
    // 保留硬超时避免请求无限占用 Run，但默认给足完整响应时间。
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async inspect(input: Parameters<VisionProvider["inspect"]>[0]) {
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
          signal,
          body: JSON.stringify({
            model: input.model,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: [
                      "请仅返回 JSON，不要 Markdown 代码块。",
                      "字段必须是 description、objects、text、colors、layout、confidence。",
                      input.prompt ??
                        "描述图片中的界面、对象、文字、颜色和布局。",
                    ].join("\n"),
                  },
                  ...input.images.map((image) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
                    },
                  })),
                ],
              },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
            max_tokens: 1_500,
          }),
        },
      );

      if (!response.ok) {
        const upstreamError = await readUpstreamError(response);
        throw new ImageError(
          IMAGE_ERROR_CODES.visionContentRejected,
          upstreamError
            ? `Vision Provider 拒绝了当前图片分析请求：${upstreamError}`
            : "Vision Provider 拒绝了当前图片分析请求。",
          response.status === 429 ? 429 : 502,
          {
            status: response.status,
            ...(upstreamError ? { upstreamError } : {}),
          },
        );
      }

      const parsedResponse = responseSchema.safeParse(await response.json());
      if (!parsedResponse.success) {
        throw new ImageError(
          IMAGE_ERROR_CODES.visionInvalidResponse,
          "Vision Provider 返回的数据结构不合法。",
          502,
          { issues: parsedResponse.error.issues },
        );
      }

      const content = parsedResponse.data.choices[0]?.message.content;
      if (!content) {
        throw new ImageError(
          IMAGE_ERROR_CODES.visionInvalidResponse,
          "Vision Provider 返回了空摘要。",
          502,
        );
      }

      return parseVisionJsonContent(content);
    } catch (error) {
      if (error instanceof ImageError) {
        throw error;
      }
      if (signal.aborted) {
        throw new ImageError(
          IMAGE_ERROR_CODES.visionTimeout,
          "Vision Provider 请求超时。",
          504,
          { timeoutMs: this.timeoutMs },
        );
      }
      throw new ImageError(
        IMAGE_ERROR_CODES.visionContentRejected,
        "Vision Provider 连接失败。",
        502,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * 上游错误响应通常包含真正的兼容性原因，例如参数不支持或模型不可用。
 * 这里只提取短消息，不记录响应头、API Key 或图片内容。
 */
async function readUpstreamError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object") {
      return null;
    }

    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") {
      return error.slice(0, 500);
    }
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return message.slice(0, 500);
      }
    }
  } catch {
    // 某些 Provider 返回纯文本或空 body，保持通用错误消息即可。
  }

  return null;
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal,
): AbortSignal {
  if (!first) {
    return second;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([first, second]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) {
    controller.abort();
  } else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
