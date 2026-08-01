import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
} from "@/infrastructure/http/agent-api";

const paramsSchema = z.object({ runId: z.uuid() }).strict();

/**
 * ChangeSet 正文只在用户主动打开审查弹窗时加载。这样普通 Agent 会话快照
 * 不需要携带每个文件的 before/after 内容，避免大项目反复传输完整 diff。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { runId } = paramsSchema.parse(await context.params);
    const { history } = getAgentPersistence();
    const changeSet = await history.getRunChangeSet({ ownerId, runId });

    return agentJsonResponse({ changeSet }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
