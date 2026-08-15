import "server-only";

import {
  AGENT_ERROR_CODES,
  isAgentError,
  serializeAgentError,
} from "@/domains/agent/errors";
import { isImageError } from "@/domains/image/errors";
import { AgentOrchestrator } from "@/domains/agent/orchestrator";
import { createAttachmentContextResolver } from "@/infrastructure/agent/attachment-context";
import { FileToolExecutor } from "@/domains/agent/file-tools";
import { ImageToolExecutor } from "@/domains/agent/image-tools";
import { AssetToolExecutor } from "@/domains/image/asset-tool";
import { VisionToolExecutor } from "@/domains/agent/vision-tools";
import { withAgentRunController } from "@/infrastructure/agent/run-controller";
import {
  getAgentProviderRuntime,
  getContextSummaryProviderRuntime,
} from "@/infrastructure/agent/provider-factory";
import { getImageProviderRuntime } from "@/infrastructure/image/image-provider-factory";
import { getVisionProviderRuntime } from "@/infrastructure/image/vision-provider-factory";
import { getAgentPersistence } from "@/infrastructure/http/agent-api";
import { getImageJobQueue } from "@/infrastructure/queue/factory";
import { getPendingImageJobForAgentRun } from "@/domains/image/job-store";
import type { AgentRunRecord } from "@/domains/agent/types";
import {
  ensureQuotaLease,
  getQuotaIpSubjectKey,
  releaseQuotaReservation,
  recordModelUsage,
  recordContextCheckpointUsage,
  reserveContextCheckpointUsageBudget,
  reserveModelUsageBudget,
  settleContextCheckpointUsageBudget,
  settleModelUsageBudget,
} from "@/infrastructure/quota/service";

export async function launchAgentRun(input: {
  ownerId: string;
  runId: string;
}): Promise<void> {
  const { store, repository } = getAgentPersistence();

  try {
    const currentRun = await store.getRun(input);
    if (currentRun.status === "awaiting_async_job") {
      await dispatchPendingImageJob(currentRun);
      return;
    }

    if (currentRun.status === "queued" || currentRun.status === "running") {
      // 刷新、队列重投和跨实例接管都要重新占用短时并发 lease，但
      // ensureQuotaLease 不会重复扣除已经消费过的每日额度。
      await ensureQuotaLease({
        resource: "agent_run",
        ownerId: currentRun.ownerId,
        resourceId: currentRun.id,
        correlationId: currentRun.correlationId,
        ipSubjectKey: await getQuotaIpSubjectKey({
          resource: "agent_run",
          resourceId: currentRun.id,
        }),
      });
    }

    // Run 创建时已经冻结了模型。恢复执行必须沿用这个模型，
    // 否则用户选择 gpt-5.5 后，后台重启会悄悄退回 DeepSeek。
    const agentProviderRuntime = getAgentProviderRuntime(currentRun.model);
    const { provider } = agentProviderRuntime;
    let checkpointRuntime:
      ReturnType<typeof getContextSummaryProviderRuntime> | undefined;
    try {
      checkpointRuntime = getContextSummaryProviderRuntime();
    } catch (error) {
      // ContextCheckpoint 是长对话优化层，不是普通 Agent 的启动前提。
      // 摘要模型配置错误时关闭本次 Run 的压缩能力，主循环仍使用原始
      // Transcript 的 96k 安全裁剪继续执行，并把原因留在服务端日志。
      console.error(
        "[agent-runtime] context checkpoint runtime unavailable",
        JSON.stringify({
          runId: currentRun.id,
          ...serializeAgentError(error),
        }),
      );
    }
    let visionTools: VisionToolExecutor | undefined;
    let attachmentContextResolver:
      ReturnType<typeof createAttachmentContextResolver> | undefined;
    try {
      const visionRuntime = getVisionProviderRuntime();
      attachmentContextResolver = createAttachmentContextResolver(
        visionRuntime.provider,
        visionRuntime.model,
      );
      visionTools = new VisionToolExecutor(store, visionRuntime.provider, {
        model: visionRuntime.model,
        profile: visionRuntime.profile,
        profileVersion: visionRuntime.profileVersion,
      });
    } catch (error) {
      // Vision 没有 Key 时不阻断普通编码 Agent。只有模型实际调用
      // inspect_attachment，才会得到稳定的配置错误。
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "IMAGE_VISION_NOT_CONFIGURED"
      ) {
        throw error;
      }
    }
    let imageRuntime: Awaited<
      ReturnType<typeof getImageProviderRuntime>
    > | null = null;
    try {
      imageRuntime = getImageProviderRuntime();
    } catch (error) {
      // 图片模型没有 Key 时不影响普通编码 Agent。真正调用
      // generate_image 时，ImageToolExecutor 会返回稳定配置错误。
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as { code?: unknown }).code !== "IMAGE_GENERATION_NOT_CONFIGURED"
      ) {
        throw error;
      }
    }
    const orchestrator = new AgentOrchestrator(
      store,
      provider,
      new FileToolExecutor(repository, store),
      visionTools,
      new ImageToolExecutor(
        store,
        getImageJobQueue(),
        imageRuntime && {
          provider: imageRuntime.providerName,
          model: imageRuntime.model,
          profile: imageRuntime.profile,
          profileVersion: imageRuntime.profileVersion,
        },
      ),
      new AssetToolExecutor(store),
      attachmentContextResolver,
      recordModelUsage,
      reserveModelUsageBudget,
      settleModelUsageBudget,
      checkpointRuntime
        ? {
            ...checkpointRuntime,
            usage: {
              record: recordContextCheckpointUsage,
              reserve: reserveContextCheckpointUsageBudget,
              settle: settleContextCheckpointUsageBudget,
            },
          }
        : undefined,
      agentProviderRuntime.contextWindowCharacters,
    );

    await withAgentRunController(input.runId, (signal) =>
      orchestrator.run({ ...input, signal }),
    );
  } catch (error) {
    const run = await store.getRun(input);

    if (
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting_async_job"
    ) {
      if (run.status === "awaiting_async_job") {
        // 异步任务的事实已经落库。队列发送失败时保留等待态，恢复入口
        // 会重新投递 image_jobs，不能把它误报成 Agent 失败。
        return;
      }
      await store.transitionRun({
        ownerId: input.ownerId,
        runId: input.runId,
        status: "failed",
        errorCode:
          isAgentError(error) || isImageError(error)
            ? error.code
            : AGENT_ERROR_CODES.providerInterrupted,
        errorMessage:
          isAgentError(error) || isImageError(error)
            ? error.message
            : "Agent 执行器启动失败。",
      });
    }

    console.error(
      "[agent-runtime]",
      JSON.stringify({
        runId: input.runId,
        ...serializeAgentError(error),
      }),
    );
  } finally {
    const latest = await store.getRun(input).catch(() => null);
    if (
      latest &&
      (latest.status === "succeeded" ||
        latest.status === "failed" ||
        latest.status === "cancelled" ||
        latest.status === "budget_exhausted" ||
        latest.status === "conflicted" ||
        latest.status === "awaiting_client_tool" ||
        latest.status === "awaiting_async_job")
    ) {
      // 等待客户端工具或异步生图时，服务端执行片段已经结束，不应继续
      // 占用全站 Agent 并发名额。释放操作按 resourceId 幂等。
      await releaseQuotaReservation({
        resource: "agent_run",
        resourceId: input.runId,
      }).catch((releaseError) => {
        console.error("[agent-runtime] quota lease release failed", {
          runId: input.runId,
          releaseError,
        });
      });
    }
  }
}

async function dispatchPendingImageJob(run: AgentRunRecord): Promise<void> {
  const pending = await getPendingImageJobForAgentRun({
    ownerId: run.ownerId,
    agentRunId: run.id,
  });

  if (!pending || pending.job.status === "running") {
    return;
  }

  await getImageJobQueue().enqueue({
    imageJobId: pending.job.id,
    imageRunId: pending.run.id,
  });
}
