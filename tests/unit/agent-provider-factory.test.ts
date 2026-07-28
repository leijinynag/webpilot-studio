// @vitest-environment node

import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import { createAgentProviderRuntime } from "@/infrastructure/agent/provider-runtime-config";

describe("createAgentProviderRuntime", () => {
  it("requires a DeepSeek API key only when Agent execution starts", () => {
    expect(() =>
      createAgentProviderRuntime({
        AGENT_ENABLED: "true",
        LLM_PROVIDER: "deepseek",
        LLM_API_KEY: undefined,
        LLM_AGENT_MODEL: "deepseek-v4-pro",
        LLM_BASE_URL: "https://api.deepseek.com",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: AGENT_ERROR_CODES.providerNotConfigured,
        status: 503,
      }),
    );
  });

  it("builds the single supported provider from reserved environment values", () => {
    const runtime = createAgentProviderRuntime({
      AGENT_ENABLED: "true",
      LLM_PROVIDER: "deepseek",
      LLM_API_KEY: "test-key",
      LLM_AGENT_MODEL: "deepseek-v4-pro",
      LLM_BASE_URL: "https://api.deepseek.com",
    });

    expect(runtime).toMatchObject({
      providerName: "deepseek",
      model: "deepseek-v4-pro",
    });
  });
});
