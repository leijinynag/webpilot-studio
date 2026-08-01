import { after } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { createFrozenAgentProfile } from "@/domains/agent/profiles";
import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import { DEFAULT_MAX_AGENT_MODEL_TURNS } from "@/domains/agent/types";
import { launchAgentRun } from "@/infrastructure/agent/runtime";
import { getAgentProviderRuntime } from "@/infrastructure/agent/provider-factory";
import { serverEnv } from "@/infrastructure/env/server";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
  readAgentJsonBody,
} from "@/infrastructure/http/agent-api";

const createAgentRunSchema = z
  .object({
    projectId: z.uuid(),
    message: z.string().trim().min(1).max(20_000),
    conversationId: z.uuid().optional(),
    locale: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
  })
  .strict();

const listRunsSchema = z.object({
  projectId: z.uuid().optional(),
});

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const body = createAgentRunSchema.parse(await readAgentJsonBody(request));
    // 先校验 Provider，避免创建一个永远无法启动的虚假 running Run。
    const providerRuntime = getAgentProviderRuntime();
    const { store, repository } = getAgentPersistence();
    const project = await repository.describe({
      ownerId,
      projectId: body.projectId,
    });
    const ownerLimit = serverEnv.MAX_CONCURRENT_RUNS_PER_OWNER ?? 1;
    const globalLimit = serverEnv.MAX_GLOBAL_AGENT_RUNS ?? 20;
    const [ownerActiveRuns, projectActiveRuns, globalActiveRuns] =
      await Promise.all([
        store.countActiveRuns({ ownerId }),
        store.countActiveRuns({ projectId: body.projectId }),
        store.countActiveRuns({}),
      ]);

    if (
      ownerActiveRuns >= ownerLimit ||
      projectActiveRuns > 0 ||
      globalActiveRuns >= globalLimit
    ) {
      throw new AgentError(
        AGENT_ERROR_CODES.runConflict,
        "当前已有 Agent Run 正在执行，请等待完成或先取消。",
        409,
        {
          ownerActiveRuns,
          projectActiveRuns,
          globalActiveRuns,
          ownerLimit,
          globalLimit,
        },
      );
    }

    if (project.storageKind !== "database" || project.status !== "ready") {
      throw new AgentError(
        AGENT_ERROR_CODES.invalidRequest,
        "首版 Agent 只支持 ready 状态的 Database Repository。",
        409,
      );
    }

    const profile = createFrozenAgentProfile({
      locale: body.locale,
      projectId: project.id,
      revision: project.revision,
      repositoryCapability: {
        storageKind: "database",
        canRead: true,
        canWrite: true,
        canExecuteServerTools: true,
      },
      provider: providerRuntime.providerName,
      model: providerRuntime.model,
      maxModelTurns:
        serverEnv.MAX_AGENT_MODEL_TURNS ?? DEFAULT_MAX_AGENT_MODEL_TURNS,
      maxWallTimeSeconds: serverEnv.MAX_AGENT_WALL_TIME_SECONDS ?? 300,
    });
    const run = await store.createRun({
      ownerId,
      projectId: body.projectId,
      conversationId: body.conversationId,
      conversationTitle: body.message.slice(0, 80),
      userMessage: body.message,
      profile,
    });

    after(async () => {
      await launchAgentRun({ ownerId, runId: run.id });
    });

    return agentJsonResponse(
      { run, correlationId: run.correlationId },
      correlationId,
      { status: 201 },
    );
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}

export async function GET(request: Request) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const url = new URL(request.url);
    const query = listRunsSchema.parse({
      projectId: url.searchParams.get("projectId") ?? undefined,
    });
    const { store } = getAgentPersistence();
    const runs = await store.listRecoverableRuns({
      ownerId,
      projectId: query.projectId,
    });

    for (const run of runs) {
      if (
        run.status !== "queued" &&
        run.status !== "running" &&
        run.status !== "awaiting_async_job"
      ) {
        continue;
      }

      after(async () => {
        await launchAgentRun({ ownerId, runId: run.id });
      });
    }

    return agentJsonResponse({ runs }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
