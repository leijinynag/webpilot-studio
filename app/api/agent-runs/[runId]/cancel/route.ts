import { z } from "zod";

import { AGENT_ERROR_CODES, isAgentError } from "@/domains/agent/errors";
import { requireRequestOwner } from "@/domains/auth/request-owner";
import { isTerminalAgentRunStatus } from "@/domains/agent/state-machine";
import { abortAgentRun } from "@/infrastructure/agent/run-controller";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
} from "@/infrastructure/http/agent-api";

const paramsSchema = z.object({ runId: z.uuid() }).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { runId } = paramsSchema.parse(await context.params);
    const { store } = getAgentPersistence();
    const fenced = await store.requestCancellation({ ownerId, runId });
    const abortedCurrentStream = abortAgentRun(runId);
    let run = fenced;

    if (!isTerminalAgentRunStatus(fenced.status)) {
      try {
        run = await store.transitionRun({
          ownerId,
          runId,
          status: "cancelled",
          errorCode: AGENT_ERROR_CODES.cancelled,
          errorMessage: "用户取消了 Agent Run。",
        });
      } catch (error) {
        if (
          !isAgentError(error) ||
          error.code !== AGENT_ERROR_CODES.runConflict
        ) {
          throw error;
        }

        // 执行器可能在 fence 写入后先一步完成 cancelled 迁移。
        // 返回数据库中的最终状态即可，取消接口保持幂等。
        run = await store.getRun({ ownerId, runId });
      }
    }

    return agentJsonResponse({ run, abortedCurrentStream }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
