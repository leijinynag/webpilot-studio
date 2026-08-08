import "server-only";

import {
  IMAGE_GENERATION_PROFILE,
  type ImageProvider,
} from "@/domains/image/generation";
import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import { OpenAiCompatibleImageProvider } from "@/infrastructure/image/image-provider";
import { serverEnv } from "@/infrastructure/env/server";

export type ImageProviderRuntime = {
  provider: ImageProvider;
  providerName: string;
  model: string;
  profile: string;
  profileVersion: string;
};

export function getImageProviderRuntime(): ImageProviderRuntime {
  if (serverEnv.IMAGE_GENERATION_ENABLED !== "true") {
    throw new ImageError(
      IMAGE_ERROR_CODES.featureDisabled,
      "图片生成尚未启用，请配置 IMAGE_GENERATION_ENABLED=true。",
      503,
    );
  }

  const apiKey = serverEnv.IMAGE_API_KEY?.trim();
  if (!apiKey) {
    throw new ImageError(
      IMAGE_ERROR_CODES.generationNotConfigured,
      "图片生成尚未配置 IMAGE_API_KEY。",
      503,
    );
  }

  const providerName = serverEnv.IMAGE_PROVIDER?.trim().toLowerCase() || "openai";
  if (providerName !== "openai" && providerName !== "openai-compatible") {
    throw new ImageError(
      IMAGE_ERROR_CODES.generationNotConfigured,
      `当前不支持 Image Provider：${providerName}。`,
      503,
    );
  }

  return {
    provider: new OpenAiCompatibleImageProvider({
      apiKey,
      baseUrl: serverEnv.IMAGE_BASE_URL || "https://api.openai.com/v1",
      timeoutMs: IMAGE_GENERATION_PROFILE.maxProviderTimeoutMs,
    }),
    providerName,
    model: serverEnv.IMAGE_MODEL?.trim() || "gpt-image-1",
    profile: IMAGE_GENERATION_PROFILE.id,
    profileVersion: IMAGE_GENERATION_PROFILE.version,
  };
}
