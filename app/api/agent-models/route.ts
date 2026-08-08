import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  getAgentModelOptions,
} from "@/infrastructure/agent/provider-factory";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
} from "@/infrastructure/http/agent-api";

export const runtime = "nodejs";

/**
 * 模型列表只返回服务端允许的白名单，不返回 Key、Base URL 或其他环境变量。
 * 页面即使在 Agent 尚未配置 Key 时也可以正常读取这份静态选择项。
 */
export async function GET(request: Request) {
  const correlationId = createRequestCorrelationId(request);

  try {
    await requireRequestOwner();
    return agentJsonResponse(
      { models: getAgentModelOptions() },
      correlationId,
    );
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
