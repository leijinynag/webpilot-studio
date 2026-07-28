import { after } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { launchAgentRun } from "@/infrastructure/agent/runtime";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
} from "@/infrastructure/http/agent-api";

const paramsSchema = z.object({ runId: z.uuid() }).strict();

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { runId } = paramsSchema.parse(await context.params);
    const { store } = getAgentPersistence();
    const run = await store.getRun({ ownerId, runId });

    if (
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting_client_tool" ||
      run.status === "awaiting_async_job"
    ) {
      after(async () => {
        await launchAgentRun({ ownerId, runId });
      });
    }

    return agentJsonResponse({ run }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
