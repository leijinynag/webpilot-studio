import "server-only";

import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import type { VisionProvider } from "@/domains/image/vision";
import { OpenAiCompatibleVisionProvider } from "@/infrastructure/image/vision-provider";
import { serverEnv } from "@/infrastructure/env/server";

export type VisionProviderRuntime = {
  provider: VisionProvider;
  providerName: string;
  model: string;
  profile: string;
  profileVersion: string;
};

export function getVisionProviderRuntime(): VisionProviderRuntime {
  const apiKey = serverEnv.VISION_API_KEY?.trim();
  if (!apiKey) {
    throw new ImageError(
      IMAGE_ERROR_CODES.visionNotConfigured,
      "Vision 功能尚未配置 VISION_API_KEY。",
      503,
    );
  }

  const providerName = serverEnv.VISION_PROVIDER?.trim().toLowerCase() || "openai";
  if (providerName !== "openai" && providerName !== "openai-compatible") {
    throw new ImageError(
      IMAGE_ERROR_CODES.visionNotConfigured,
      `当前不支持 Vision Provider：${providerName}。`,
      503,
    );
  }

  return {
    provider: new OpenAiCompatibleVisionProvider({
      apiKey,
      baseUrl: serverEnv.VISION_BASE_URL || "https://api.openai.com/v1",
    }),
    providerName,
    model: serverEnv.VISION_MODEL?.trim() || "gpt-4.1-mini",
    profile: "image-vision-default",
    profileVersion: "v1",
  };
}
