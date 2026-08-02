import { z } from "zod";

export const IMAGE_GENERATION_PROFILE = {
  id: "image-generation-default",
  version: "v1",
  maxImages: 4,
  maxPromptCharacters: 4_000,
  maxProviderTimeoutMs: 90_000,
  defaultSize: "1024x1024",
} as const;

export const generateImageArgumentsSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(IMAGE_GENERATION_PROFILE.maxPromptCharacters),
    count: z
      .number()
      .int()
      .min(1)
      .max(IMAGE_GENERATION_PROFILE.maxImages)
      .default(1),
    size: z
      .enum(["1024x1024", "1024x1536", "1536x1024"])
      .default(IMAGE_GENERATION_PROFILE.defaultSize),
  })
  .strict();

export type GenerateImageArguments = z.infer<
  typeof generateImageArgumentsSchema
>;

export type GeneratedImage = {
  bytes: Uint8Array;
  mimeType: string;
  providerImageId?: string;
};

export type ImageProvider = {
  generate(input: {
    prompt: string;
    count: number;
    size: GenerateImageArguments["size"];
    model: string;
    signal?: AbortSignal;
  }): Promise<{
    images: readonly GeneratedImage[];
    providerJobId?: string;
  }>;
};
