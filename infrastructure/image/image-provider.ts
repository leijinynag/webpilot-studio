import { z } from "zod";

import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import type {
  GeneratedImage,
  ImageProvider,
} from "@/domains/image/generation";

const responseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            b64_json: z.string().min(1).optional(),
            url: z.url().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

type FetchLike = typeof fetch;

export type OpenAiCompatibleImageProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImplementation?: FetchLike;
};

/**
 * 统一适配 OpenAI-compatible Images API。
 *
 * 第一版固定要求供应商返回 base64，避免 Worker 依赖供应商临时 URL 的
 * 生命周期。将来需要支持 URL 时，可以在这里增加受控下载和 SSRF 校验。
 */
export class OpenAiCompatibleImageProvider implements ImageProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchLike;

  constructor(private readonly options: OpenAiCompatibleImageProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async generate(input: Parameters<ImageProvider["generate"]>[0]) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      this.timeoutMs,
    );
    const signal = combineAbortSignals(input.signal, timeoutController.signal);

    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/images/generations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: input.model,
            prompt: input.prompt,
            n: input.count,
            size: input.size,
            response_format: "b64_json",
          }),
        },
      );

      if (!response.ok) {
        throw new ImageError(
          IMAGE_ERROR_CODES.generationContentRejected,
          "Image Provider 拒绝了当前生图请求。",
          response.status === 429 || response.status >= 500 ? response.status : 502,
          { status: response.status },
        );
      }

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new ImageError(
          IMAGE_ERROR_CODES.generationInvalidResponse,
          "Image Provider 返回的数据结构不合法。",
          502,
          { issues: parsed.error.issues },
        );
      }

      const images: GeneratedImage[] = [];
      for (const item of parsed.data.data) {
        if (!item.b64_json) {
          throw new ImageError(
            IMAGE_ERROR_CODES.generationInvalidResponse,
            "Image Provider 未返回可持久化的 base64 图片。",
            502,
          );
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
        } catch {
          throw new ImageError(
            IMAGE_ERROR_CODES.generationInvalidResponse,
            "Image Provider 返回了无效的 base64 图片。",
            502,
          );
        }
        if (bytes.length === 0) {
          throw new ImageError(
            IMAGE_ERROR_CODES.generationInvalidResponse,
            "Image Provider 返回了空图片。",
            502,
          );
        }
        images.push({
          bytes,
          mimeType: "image/png",
          providerImageId: item.url,
        });
      }

      return { images };
    } catch (error) {
      if (error instanceof ImageError) {
        throw error;
      }
      if (signal.aborted) {
        throw new ImageError(
          IMAGE_ERROR_CODES.generationTimeout,
          "Image Provider 请求超时。",
          504,
          { timeoutMs: this.timeoutMs },
        );
      }
      throw new ImageError(
        IMAGE_ERROR_CODES.generationFailed,
        "Image Provider 连接失败。",
        502,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
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
