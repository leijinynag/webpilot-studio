import { after } from "next/server";
import { z } from "zod";

import { clientToolResultRequestSchema } from "@/domains/agent/evidence";
import { requireRequestOwner } from "@/domains/auth/request-owner";
import { launchAgentRun } from "@/infrastructure/agent/runtime";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
  readAgentJsonBody,
} from "@/infrastructure/http/agent-api";

const paramsSchema = z.object({ runId: z.uuid() }).strict();

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { runId } = paramsSchema.parse(await context.params);
    const body = clientToolResultRequestSchema.parse(
      await readAgentJsonBody(request),
    );
    const { store } = getAgentPersistence();
    const completion = await store.completeClientToolResult({
      ownerId,
      runId,
      ...body,
    });

    if (
      completion.disposition === "accepted" &&
      completion.run.status === "running"
    ) {
      // 数据库已经原子地把 Run 恢复到 running；after 只负责启动下一轮，
      // 即使当前请求结束或实例回收，后续 GET 恢复也能重新接管。
      after(async () => {
        await launchAgentRun({ ownerId, runId });
      });
    }

    return agentJsonResponse(
      {
        disposition: completion.disposition,
        run: completion.run,
      },
      correlationId,
      { status: completion.disposition === "ignored" ? 202 : 200 },
    );
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
