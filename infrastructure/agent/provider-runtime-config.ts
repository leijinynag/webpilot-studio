import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { LlmProvider } from "@/domains/agent/provider";
import { DeepSeekProvider } from "@/infrastructure/agent/deepseek-provider";
import type { ServerEnv } from "@/infrastructure/env/schema";

export type AgentProviderRuntime = {
  provider: LlmProvider;
  providerName: "deepseek";
  model: string;
};

/**
 * 保持为不读取 process.env 的纯函数，便于在没有真实 Key 的测试和构建阶段
 * 验证配置边界。真正的服务端入口只负责传入已经由 Zod 校验过的环境对象。
 */
export function createAgentProviderRuntime(
  environment: Pick<
    ServerEnv,
    | "AGENT_ENABLED"
    | "LLM_PROVIDER"
    | "LLM_API_KEY"
    | "LLM_AGENT_MODEL"
    | "LLM_BASE_URL"
  >,
): AgentProviderRuntime {
  if (environment.AGENT_ENABLED !== "true") {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "Agent 功能尚未启用。",
      503,
    );
  }

  const providerName = environment.LLM_PROVIDER?.toLowerCase();
  const apiKey = environment.LLM_API_KEY?.trim();
  const model = environment.LLM_AGENT_MODEL?.trim() || "deepseek-v4-pro";

  if (providerName !== "deepseek" || !apiKey) {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "请配置 DeepSeek Provider 和 LLM_API_KEY 后再启动 Agent Run。",
      503,
    );
  }

  return {
    providerName: "deepseek",
    model,
    provider: new DeepSeekProvider({
      apiKey,
      baseUrl: environment.LLM_BASE_URL || "https://api.deepseek.com",
    }),
  };
}
