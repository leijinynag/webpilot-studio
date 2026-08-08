// @vitest-environment node

import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import {
  createAgentProviderRuntime,
  getAgentModelOptions,
} from "@/infrastructure/agent/provider-runtime-config";

describe("createAgentProviderRuntime", () => {
  it("从两个预留环境变量生成去重后的模型白名单", () => {
    expect(
      getAgentModelOptions({
        LLM_AGENT_MODEL: "deepseek-custom",
        LLM_FAST_MODEL: "deepseek-custom",
      }),
    ).toEqual([
      {
        id: "deepseek-custom",
        label: "deepseek-custom",
        tier: "agent",
      },
    ]);
  });

  it("未配置模型时使用稳定的默认模型列表", () => {
    expect(
      getAgentModelOptions({
        LLM_AGENT_MODEL: undefined,
        LLM_FAST_MODEL: undefined,
      }),
    ).toEqual([
      {
        id: "deepseek-v4-pro",
        label: "deepseek-v4-pro",
        tier: "agent",
      },
      {
        id: "deepseek-v4-flash",
        label: "deepseek-v4-flash",
        tier: "fast",
      },
    ]);
  });

  it("已配置 Vision 兼容模型时将其加入 Agent 模型列表", () => {
    expect(
      getAgentModelOptions({
        LLM_AGENT_MODEL: "deepseek-v4-pro",
        LLM_FAST_MODEL: "deepseek-v4-flash",
        VISION_PROVIDER: "openai-compatible",
        VISION_API_KEY: "vision-test-key",
        VISION_MODEL: "gpt-5.5",
      }),
    ).toEqual([
      {
        id: "deepseek-v4-pro",
        label: "deepseek-v4-pro",
        tier: "agent",
      },
      {
        id: "deepseek-v4-flash",
        label: "deepseek-v4-flash",
        tier: "fast",
      },
      {
        id: "gpt-5.5",
        label: "gpt-5.5",
        tier: "agent",
      },
    ]);
  });

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

  it("拒绝不在服务端白名单中的请求模型", () => {
    expect(() =>
      createAgentProviderRuntime(
        {
          AGENT_ENABLED: "true",
          LLM_PROVIDER: "deepseek",
          LLM_API_KEY: "test-key",
          LLM_AGENT_MODEL: "deepseek-v4-pro",
          LLM_FAST_MODEL: "deepseek-v4-flash",
          LLM_BASE_URL: "https://api.deepseek.com",
        },
        "unknown-model",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: AGENT_ERROR_CODES.invalidRequest,
        status: 400,
      }),
    );
  });

  it("把请求模型冻结到当前 Run 的 Provider runtime", () => {
    const runtime = createAgentProviderRuntime(
      {
        AGENT_ENABLED: "true",
        LLM_PROVIDER: "deepseek",
        LLM_API_KEY: "test-key",
        LLM_AGENT_MODEL: "deepseek-v4-pro",
        LLM_FAST_MODEL: "deepseek-v4-flash",
        LLM_BASE_URL: "https://api.deepseek.com",
      },
      "deepseek-v4-flash",
    );

    expect(runtime.model).toBe("deepseek-v4-flash");
  });

  it("选择 Vision 兼容模型时使用 VISION Provider 配置", () => {
    const runtime = createAgentProviderRuntime(
      {
        AGENT_ENABLED: "true",
        LLM_PROVIDER: "deepseek",
        LLM_API_KEY: "deepseek-test-key",
        LLM_AGENT_MODEL: "deepseek-v4-pro",
        LLM_FAST_MODEL: "deepseek-v4-flash",
        LLM_BASE_URL: "https://api.deepseek.com",
        VISION_PROVIDER: "openai-compatible",
        VISION_BASE_URL: "https://apinebula.ai/v1",
        VISION_API_KEY: "vision-test-key",
        VISION_MODEL: "gpt-5.5",
      },
      "gpt-5.5",
    );

    expect(runtime).toMatchObject({
      providerName: "openai-compatible",
      model: "gpt-5.5",
    });
  });
});
