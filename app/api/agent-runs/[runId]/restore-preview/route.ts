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
 * 预检基于当前 Repository manifest 做三方比较，返回此次恢复会写入、删除或
 * 跳过哪些路径。它用于解释风险，但最终恢复仍会在事务内重新计算一次。
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
    const preview = await history.previewRestore({ ownerId, runId });

    return agentJsonResponse({ preview }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
