import { describe, expect, it } from "vitest";

import { IMAGE_ERROR_CODES } from "@/domains/image/errors";
import {
  generateImageArgumentsSchema,
  IMAGE_GENERATION_PROFILE,
} from "@/domains/image/generation";
import {
  inspectAttachmentArgumentsSchema,
  VISION_PROFILE,
} from "@/domains/image/vision";
import {
  parseVisionJsonContent,
  parseVisionSummary,
} from "@/domains/image/vision-summary";

describe("image tool contracts", () => {
  it("限制 Vision 一次最多四张图片并拒绝未知字段", () => {
    const ids = Array.from(
      { length: VISION_PROFILE.maxAttachments + 1 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );

    expect(
      inspectAttachmentArgumentsSchema.safeParse({ attachmentIds: ids })
        .success,
    ).toBe(false);
    expect(
      inspectAttachmentArgumentsSchema.safeParse({
        attachmentIds: [ids[0]],
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("为 Vision 和生图参数填充默认值", () => {
    expect(
      inspectAttachmentArgumentsSchema.parse({
        attachmentIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    ).toEqual({
      attachmentIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(
      generateImageArgumentsSchema.parse({ prompt: "一张蓝色海报" }),
    ).toMatchObject({
      prompt: "一张蓝色海报",
      count: 1,
      size: IMAGE_GENERATION_PROFILE.defaultSize,
    });
  });

  it("限制生图数量、提示词长度和尺寸枚举", () => {
    expect(
      generateImageArgumentsSchema.safeParse({
        prompt: "poster",
        count: IMAGE_GENERATION_PROFILE.maxImages + 1,
      }).success,
    ).toBe(false);
    expect(
      generateImageArgumentsSchema.safeParse({
        prompt: "poster",
        size: "512x512",
      }).success,
    ).toBe(false);
    expect(
      generateImageArgumentsSchema.safeParse({
        prompt: "x".repeat(IMAGE_GENERATION_PROFILE.maxPromptCharacters + 1),
      }).success,
    ).toBe(false);
  });

  it("只接受有界的结构化 Vision 摘要", () => {
    const valid = {
      description: "一个登录界面",
      objects: ["表单", "按钮"],
      text: ["登录"],
      colors: ["蓝色"],
      layout: "居中布局",
      confidence: 0.96,
    };

    expect(parseVisionSummary(valid)).toEqual(valid);
    expect(
      parseVisionJsonContent(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``),
    ).toEqual(valid);
    expect(() =>
      parseVisionSummary({ ...valid, extra: "not allowed" }),
    ).toThrowError(
      expect.objectContaining({
        code: IMAGE_ERROR_CODES.visionInvalidResponse,
      }),
    );
    expect(() => parseVisionJsonContent("not-json")).toThrowError(
      expect.objectContaining({
        code: IMAGE_ERROR_CODES.visionInvalidResponse,
      }),
    );
  });
});
