import { z } from "zod";

import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";

const boundedText = (max: number) => z.string().trim().max(max);

/**
 * Vision 输出必须收敛成固定结构。
 *
 * 模型可能会返回额外字段、Markdown 或超长自由文本；strict schema 会先
 * 拒绝未知字段，再由服务层限制每个数组和文本字段的体积，避免把模型输出
 * 原样塞回 Transcript，造成上下文膨胀。
 */
export const visionSummarySchema = z
  .object({
    description: boundedText(2_000),
    objects: z.array(boundedText(160)).max(40),
    text: z.array(boundedText(500)).max(40),
    colors: z.array(boundedText(80)).max(20),
    layout: boundedText(500),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type VisionSummary = z.infer<typeof visionSummarySchema>;

export function parseVisionSummary(value: unknown): VisionSummary {
  const parsed = visionSummarySchema.safeParse(value);
  if (!parsed.success) {
    throw new ImageError(
      IMAGE_ERROR_CODES.visionInvalidResponse,
      "Vision Provider 返回的摘要结构不合法。",
      502,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export function parseVisionJsonContent(content: string): VisionSummary {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  try {
    return parseVisionSummary(JSON.parse(normalized));
  } catch (error) {
    if (error instanceof ImageError) {
      throw error;
    }
    throw new ImageError(
      IMAGE_ERROR_CODES.visionInvalidResponse,
      "Vision Provider 没有返回可解析的 JSON 摘要。",
      502,
    );
  }
}
