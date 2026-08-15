import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { LlmProvider } from "@/domains/agent/provider";
import { DeepSeekProvider } from "@/infrastructure/agent/deepseek-provider";
import { OpenAiCompatibleAgentProvider } from "@/infrastructure/agent/openai-compatible-agent-provider";
import type { ServerEnv } from "@/infrastructure/env/schema";

export type AgentProviderName = "deepseek" | "openai-compatible";

export type AgentProviderRuntime = {
  provider: LlmProvider;
  providerName: AgentProviderName;
  model: string;
};

export type AgentModelOption = {
  id: string;
  label: string;
  tier: "agent" | "fast";
};

type ConfiguredAgentModel = AgentModelOption & {
  provider: AgentProviderName;
};

const DEFAULT_AGENT_MODEL = "deepseek-v4-pro";
const DEFAULT_FAST_MODEL = "deepseek-v4-flash";

/**
 * 模型配置只允许来自服务端预留的两个环境变量。
 * 前端展示的是这个白名单，不能通过 POST 任意把供应商模型名注入 Run。
 */
export function getAgentModelOptions(
  environment: Pick<
    ServerEnv,
    | "LLM_AGENT_MODEL"
    | "LLM_FAST_MODEL"
    | "VISION_PROVIDER"
    | "VISION_API_KEY"
    | "VISION_MODEL"
  >,
): AgentModelOption[] {
  return resolveConfiguredAgentModels(environment).map((option) => ({
    id: option.id,
    label: option.label,
    tier: option.tier,
  }));
}

/**
 * Provider 路由只在服务端保留。公开接口只返回模型名和档位，
 * 不让前端承担“哪个模型使用哪套 Key/Base URL”的安全边界。
 */
function resolveConfiguredAgentModels(
  environment: Pick<
    ServerEnv,
    | "LLM_AGENT_MODEL"
    | "LLM_FAST_MODEL"
    | "VISION_PROVIDER"
    | "VISION_API_KEY"
    | "VISION_MODEL"
  >,
): ConfiguredAgentModel[] {
  const configured: ConfiguredAgentModel[] = [
    {
      id: environment.LLM_AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL,
      label: environment.LLM_AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL,
      tier: "agent" as const,
      provider: "deepseek" as const,
    },
    {
      id: environment.LLM_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL,
      label: environment.LLM_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL,
      tier: "fast" as const,
      provider: "deepseek" as const,
    },
  ];
  const visionProvider = environment.VISION_PROVIDER?.trim().toLowerCase();
  if (
    environment.VISION_API_KEY?.trim() &&
    environment.VISION_MODEL?.trim() &&
    (!visionProvider ||
      visionProvider === "openai" ||
      visionProvider === "openai-compatible")
  ) {
    configured.push({
      id: environment.VISION_MODEL.trim(),
      label: environment.VISION_MODEL.trim(),
      tier: "agent",
      provider: "openai-compatible",
    });
  }
  const seen = new Set<string>();

  return configured
    .filter((option) => {
      if (seen.has(option.id)) {
        return false;
      }
      seen.add(option.id);
      return true;
    })
    .map((option) => option);
}

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
    | "LLM_FAST_MODEL"
    | "LLM_BASE_URL"
    | "VISION_PROVIDER"
    | "VISION_BASE_URL"
    | "VISION_API_KEY"
    | "VISION_MODEL"
  >,
  requestedModel?: string,
): AgentProviderRuntime {
  if (environment.AGENT_ENABLED !== "true") {
    throw new AgentError(
      AGENT_ERROR_CODES.featureDisabled,
      "Agent 功能尚未启用。",
      503,
    );
  }

  const providerName = environment.LLM_PROVIDER?.toLowerCase();
  const apiKey = environment.LLM_API_KEY?.trim();
  const modelOptions = resolveConfiguredAgentModels(environment);
  const requested = requestedModel?.trim();
  const model = requested || modelOptions[0]?.id || DEFAULT_AGENT_MODEL;
  const selectedOption = modelOptions.find((option) => option.id === model);

  if (!selectedOption) {
    throw new AgentError(
      AGENT_ERROR_CODES.invalidRequest,
      "请求的模型不在当前部署允许的模型列表中。",
      400,
      { requestedModel: model },
    );
  }

  if (selectedOption.provider === "deepseek") {
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

  const visionProvider = environment.VISION_PROVIDER?.trim().toLowerCase();
  const visionApiKey = environment.VISION_API_KEY?.trim();
  if (
    !visionApiKey ||
    (visionProvider !== "openai" && visionProvider !== "openai-compatible")
  ) {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "请配置 OpenAI-compatible Provider 和 VISION_API_KEY 后再启动 Agent Run。",
      503,
    );
  }

  return {
    providerName: "openai-compatible",
    model,
    provider: new OpenAiCompatibleAgentProvider({
      apiKey: visionApiKey,
      baseUrl: environment.VISION_BASE_URL || "https://api.openai.com/v1",
    }),
  };
}

/**
 * Checkpoint 摘要是内部维护调用，不进入前端模型白名单。它仍复用同一套
 * DeepSeek 凭证和 Base URL，但模型名优先读取专用配置，避免占用主 Agent
 * 的高成本模型；未配置时回退快速模型。
 */
export function createContextSummaryProviderRuntime(
  environment: Pick<
    ServerEnv,
    | "AGENT_ENABLED"
    | "LLM_PROVIDER"
    | "LLM_API_KEY"
    | "LLM_BASE_URL"
    | "LLM_FAST_MODEL"
    | "LLM_SUMMARY_MODEL"
  >,
): AgentProviderRuntime {
  if (environment.AGENT_ENABLED !== "true") {
    throw new AgentError(
      AGENT_ERROR_CODES.featureDisabled,
      "Agent 功能尚未启用。",
      503,
    );
  }
  if (environment.LLM_PROVIDER?.toLowerCase() !== "deepseek") {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "ContextCheckpoint 当前需要 DeepSeek Provider。",
      503,
    );
  }
  const apiKey = environment.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "请配置 LLM_API_KEY 后再生成 ContextCheckpoint。",
      503,
    );
  }

  return {
    providerName: "deepseek",
    model:
      environment.LLM_SUMMARY_MODEL?.trim() ||
      environment.LLM_FAST_MODEL?.trim() ||
      DEFAULT_FAST_MODEL,
    provider: new DeepSeekProvider({
      apiKey,
      baseUrl: environment.LLM_BASE_URL || "https://api.deepseek.com",
    }),
  };
}

/**
 * 行内补全是短请求，不能让客户端传入任意模型名，也不应复用 Agent
 * Run 的模型白名单。服务端只从专用配置或快速模型回退值中选择模型，
 * 并沿用主 LLM Provider 的密钥与 Base URL。
 */
export function createCodeCompletionProviderRuntime(
  environment: Pick<
    ServerEnv,
    | "AGENT_ENABLED"
    | "LLM_PROVIDER"
    | "LLM_API_KEY"
    | "LLM_BASE_URL"
    | "LLM_FAST_MODEL"
    | "CODE_COMPLETION_MODEL"
  >,
): AgentProviderRuntime {
  if (environment.AGENT_ENABLED !== "true") {
    throw new AgentError(
      AGENT_ERROR_CODES.featureDisabled,
      "Agent 功能尚未启用。",
      503,
    );
  }

  if (environment.LLM_PROVIDER?.toLowerCase() !== "deepseek") {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "代码补全当前需要 DeepSeek Provider。",
      503,
    );
  }

  const apiKey = environment.LLM_API_KEY?.trim();
  if (!apiKey) {
    throw new AgentError(
      AGENT_ERROR_CODES.providerNotConfigured,
      "请配置 LLM_API_KEY 后再使用代码补全。",
      503,
    );
  }

  return {
    providerName: "deepseek",
    model:
      environment.CODE_COMPLETION_MODEL?.trim() ||
      environment.LLM_FAST_MODEL?.trim() ||
      DEFAULT_FAST_MODEL,
    provider: new DeepSeekProvider({
      apiKey,
      baseUrl: environment.LLM_BASE_URL || "https://api.deepseek.com",
    }),
  };
}
