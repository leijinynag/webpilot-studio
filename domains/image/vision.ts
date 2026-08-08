import { z } from "zod";

import type { VisionSummary } from "@/domains/image/vision-summary";

export const VISION_PROFILE = {
  id: "image-vision-default",
  version: "v1",
  maxAttachments: 4,
  maxPromptCharacters: 1_000,
  maxProviderTimeoutMs: 30_000,
} as const;

export const inspectAttachmentArgumentsSchema = z
  .object({
    attachmentIds: z.array(z.uuid()).min(1).max(VISION_PROFILE.maxAttachments),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(VISION_PROFILE.maxPromptCharacters)
      .optional(),
  })
  .strict();

export type InspectAttachmentArguments = z.infer<
  typeof inspectAttachmentArgumentsSchema
>;

export type VisionImage = {
  attachmentId: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
  filename: string;
};

export type VisionProvider = {
  inspect(input: {
    images: readonly VisionImage[];
    prompt?: string;
    model: string;
    signal?: AbortSignal;
  }): Promise<VisionSummary>;
};
