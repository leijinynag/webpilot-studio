import { describe, expect, it } from "vitest";

import { IMAGE_ERROR_CODES } from "@/domains/image/errors";
import {
  buildGeneratedImagePathname,
  buildPrivateImagePathname,
  validateGeneratedImage,
  validateImageFile,
} from "@/domains/image/validation";

const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

describe("image validation", () => {
  it("校验 PNG 魔数和尺寸，并清理不安全文件名", async () => {
    const file = new File([PNG_1X1], "../hero:image.png", {
      type: "image/png",
    });

    await expect(validateImageFile(file)).resolves.toMatchObject({
      mimeType: "image/png",
      format: "png",
      width: 1,
      height: 1,
      originalFilename: "..-hero-image.png",
      byteLength: PNG_1X1.byteLength,
    });
  });

  it("拒绝伪造 MIME 的非图片内容", async () => {
    const file = new File(["not an image"], "payload.png", {
      type: "image/png",
    });

    await expect(validateImageFile(file)).rejects.toMatchObject({
      code: IMAGE_ERROR_CODES.mimeMismatch,
    });
  });

  it("拒绝不支持的 MIME 类型和过大的图片", async () => {
    const unsupported = new File([PNG_1X1], "hero.gif", {
      type: "image/gif",
    });
    await expect(validateImageFile(unsupported)).rejects.toMatchObject({
      code: IMAGE_ERROR_CODES.unsupportedMime,
    });

    const oversized = new File(
      [new Uint8Array(10 * 1024 * 1024 + 1)],
      "large.png",
      { type: "image/png" },
    );
    await expect(validateImageFile(oversized)).rejects.toMatchObject({
      code: IMAGE_ERROR_CODES.fileTooLarge,
    });
  });

  it("复用同一套校验拒绝 Provider 返回的非法图片", () => {
    expect(() =>
      validateGeneratedImage({
        bytes: Uint8Array.from([1, 2, 3, 4]),
        mimeType: "image/png",
        originalFilename: "generated-1",
      }),
    ).toThrowError(
      expect.objectContaining({ code: IMAGE_ERROR_CODES.mimeMismatch }),
    );
  });

  it("生成私有路径时只使用受控 ID 和图片扩展名", () => {
    expect(
      buildPrivateImagePathname({
        ownerId: "owner-1",
        projectId: "project-1",
        attachmentId: "attachment-1",
        filename: "hero.jpeg",
      }),
    ).toBe(
      "private-assets/owner-1/project-1/attachment-1.jpg",
    );
    expect(
      buildGeneratedImagePathname({
        ownerId: "owner-1",
        projectId: "project-1",
        imageRunId: "run-1",
        generationIndex: 0,
        format: "png",
      }),
    ).toBe(
      "private-assets/owner-1/project-1/generated/run-1/0.png",
    );
  });
});
