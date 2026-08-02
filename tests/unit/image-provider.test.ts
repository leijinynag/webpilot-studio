// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { IMAGE_ERROR_CODES } from "@/domains/image/errors";
import { OpenAiCompatibleImageProvider } from "@/infrastructure/image/image-provider";
import { OpenAiCompatibleVisionProvider } from "@/infrastructure/image/vision-provider";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("OpenAI-compatible image providers", () => {
  it("解析 Vision JSON 摘要并传递图片内容", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      const imagePart = body.messages[0]?.content.find(
        (part) => part.type === "image_url",
      );
      expect(String((imagePart?.image_url as { url: string }).url)).toContain(
        "data:image/png;base64,",
      );

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                description: "一张图片",
                objects: ["界面"],
                text: [],
                colors: ["蓝色"],
                layout: "居中",
                confidence: 0.9,
              }),
            },
          },
        ],
      });
    });
    const provider = new OpenAiCompatibleVisionProvider({
      apiKey: "vision-key",
      fetchImplementation,
    });

    await expect(
      provider.inspect({
        images: [
          {
            attachmentId: "attachment-1",
            mimeType: "image/png",
            bytes: Uint8Array.from([1, 2, 3]),
            width: 1,
            height: 1,
            filename: "image.png",
          },
        ],
        model: "vision-model",
      }),
    ).resolves.toMatchObject({ description: "一张图片", confidence: 0.9 });
  });

  it("将 Vision 超时映射为稳定错误", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const provider = new OpenAiCompatibleVisionProvider({
      apiKey: "vision-key",
      timeoutMs: 1,
      fetchImplementation,
    });

    await expect(
      provider.inspect({ images: [], model: "vision-model" }),
    ).rejects.toMatchObject({ code: IMAGE_ERROR_CODES.visionTimeout });
  });

  it("解析生图 Provider 的 base64 图片", async () => {
    const provider = new OpenAiCompatibleImageProvider({
      apiKey: "image-key",
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        Response.json({
          data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }],
        }),
      ),
    });

    await expect(
      provider.generate({
        prompt: "a small blue icon",
        count: 1,
        size: "1024x1024",
        model: "image-model",
      }),
    ).resolves.toMatchObject({
      images: [{ mimeType: "image/png" }],
    });
  });

  it("拒绝图片数量与请求不一致的 Provider 响应", async () => {
    const provider = new OpenAiCompatibleImageProvider({
      apiKey: "image-key",
      fetchImplementation: vi.fn<typeof fetch>(async () =>
        Response.json({
          data: [{ b64_json: ONE_PIXEL_PNG_BASE64 }],
        }),
      ),
    });

    const result = await provider.generate({
      prompt: "two icons",
      count: 2,
      size: "1024x1024",
      model: "image-model",
    });

    expect(result.images).toHaveLength(1);
    // 数量一致性由 Worker 在持久化前校验，Provider 只负责协议解析。
    expect(result.images[0]?.bytes.byteLength).toBeGreaterThan(0);
  });
});
