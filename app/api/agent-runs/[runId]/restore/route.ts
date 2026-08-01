import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
  readAgentJsonBody,
} from "@/infrastructure/http/agent-api";

const paramsSchema = z.object({ runId: z.uuid() }).strict();
const restoreSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { runId } = paramsSchema.parse(await context.params);
    const body = restoreSchema.parse(await readAgentJsonBody(request));
    const { history } = getAgentPersistence();

    // expectedRevision 只是乐观锁输入，不代表客户端可以决定恢复结果。
    // Service 会在同一事务里重新读取 manifest、检查冲突并完成 revision CAS。
    const result = await history.restoreRunChangeSet({
      ownerId,
      runId,
      expectedRevision: body.expectedRevision,
    });

    return agentJsonResponse({ result }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
