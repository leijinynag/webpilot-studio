import { after } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { createFrozenAgentProfile } from "@/domains/agent/profiles";
import { deriveRepositoryIntent } from "@/domains/agent/repository-intent";
import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import {
  DEFAULT_AGENT_RUN_ACTIVITY_LIMITS,
  DEFAULT_MAX_AGENT_MODEL_TURNS,
  DEFAULT_MAX_AGENT_WALL_TIME_SECONDS,
} from "@/domains/agent/types";
import { launchAgentRun } from "@/infrastructure/agent/runtime";
import { getAgentProviderRuntime } from "@/infrastructure/agent/provider-factory";
import { serverEnv } from "@/infrastructure/env/server";
import {
  bindQuotaReservation,
  releaseQuotaReservation,
  reserveQuota,
} from "@/infrastructure/quota/service";
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
    attachmentIds: z.array(z.uuid()).max(4).default([]),
    model: z.string().trim().min(1).max(160).optional(),
    locale: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
    repositoryRevision: z.number().int().nonnegative().optional(),
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
    // 额度预留必须在创建 Run 前完成，避免 Provider 校验和数据库写入之间
    // 出现大量并发请求绕过日额度。若后续校验失败，统一释放租约。
    const quotaReservation = await reserveQuota({
      resource: "agent_run",
      ownerId,
      request,
      correlationId,
    });
    // 先校验 Provider，避免创建一个永远无法启动的虚假 running Run。
    try {
      const providerRuntime = getAgentProviderRuntime(body.model);
      const { store, repository } = getAgentPersistence();
      const project = await repository.describe({
        ownerId,
        projectId: body.projectId,
      });

      if (project.status !== "ready") {
        throw new AgentError(
          AGENT_ERROR_CODES.invalidRequest,
          "Agent 只支持 ready 状态的 Repository。",
          409,
        );
      }

      const startRevision =
        project.storageKind === "browser_git"
          ? body.repositoryRevision
          : project.revision;

      if (startRevision === undefined) {
        throw new AgentError(
          AGENT_ERROR_CODES.invalidRequest,
          "Browser Git Agent Run 必须提交浏览器仓库的真实 revision。",
          400,
        );
      }

      if (
        project.storageKind === "database" &&
        body.repositoryRevision !== undefined &&
        body.repositoryRevision !== project.revision
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.revisionConflict,
          "Database Repository revision 以服务端为准。",
          409,
          {
            requestedRevision: body.repositoryRevision,
            currentRevision: project.revision,
          },
        );
      }

      const profile = createFrozenAgentProfile({
        locale: body.locale,
        projectId: project.id,
        revision: startRevision,
        repositoryCapability: {
          storageKind: project.storageKind,
          canRead: true,
          canWrite: true,
          canExecuteServerTools: project.storageKind === "database",
          repositoryIntent:
            project.storageKind === "browser_git"
              ? deriveRepositoryIntent(body.message)
              : undefined,
        },
        provider: providerRuntime.providerName,
        model: providerRuntime.model,
        maxModelTurns:
          serverEnv.MAX_AGENT_MODEL_TURNS ?? DEFAULT_MAX_AGENT_MODEL_TURNS,
        maxFileMutations:
          serverEnv.MAX_AGENT_FILE_MUTATIONS ??
          DEFAULT_AGENT_RUN_ACTIVITY_LIMITS.maxFileMutations,
        maxWallTimeSeconds:
          serverEnv.MAX_AGENT_WALL_TIME_SECONDS ??
          DEFAULT_MAX_AGENT_WALL_TIME_SECONDS,
      });
      const run = await store.createRun({
        ownerId,
        projectId: body.projectId,
        conversationId: body.conversationId,
        conversationTitle: body.message.slice(0, 80),
        userMessage: body.message,
        attachmentIds: body.attachmentIds,
        profile,
        startRevision,
      });

      await bindQuotaReservation({
        reservation: quotaReservation,
        resourceId: run.id,
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
      // Provider、项目或 revision 校验失败时还没有创建真实 Run，
      // 因此必须把这次预留的日额度一并退回；否则一次输入错误
      // 就会永久消耗当天额度。
      await releaseQuotaReservation({
        reservation: quotaReservation,
        refundUnits: 1,
      });
      throw error;
    }
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
