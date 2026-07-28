import "server-only";

import {
  createAgentProviderRuntime,
  type AgentProviderRuntime,
} from "@/infrastructure/agent/provider-runtime-config";
import { serverEnv } from "@/infrastructure/env/server";

/**
 * 环境变量只在真正启动 Agent Run 时读取和校验。
 * 因此没有 API Key 仍可完成 build、数据库迁移与非 Agent 页面访问。
 */
export function getAgentProviderRuntime(): AgentProviderRuntime {
  return createAgentProviderRuntime(serverEnv);
}
