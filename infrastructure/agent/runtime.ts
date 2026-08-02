import "server-only";

import {
  AGENT_ERROR_CODES,
  isAgentError,
  serializeAgentError,
} from "@/domains/agent/errors";
import { AgentOrchestrator } from "@/domains/agent/orchestrator";
import { FileToolExecutor } from "@/domains/agent/file-tools";
import { ImageToolExecutor } from "@/domains/agent/image-tools";
import { VisionToolExecutor } from "@/domains/agent/vision-tools";
import { withAgentRunController } from "@/infrastructure/agent/run-controller";
import { getAgentProviderRuntime } from "@/infrastructure/agent/provider-factory";
import { getImageProviderRuntime } from "@/infrastructure/image/image-provider-factory";
import { getVisionProviderRuntime } from "@/infrastructure/image/vision-provider-factory";
import { getAgentPersistence } from "@/infrastructure/http/agent-api";
import { getImageJobQueue } from "@/infrastructure/queue/factory";
import { getPendingImageJobForAgentRun } from "@/domains/image/job-store";
import type { AgentRunRecord } from "@/domains/agent/types";

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

    const { provider } = getAgentProviderRuntime();
    let visionTools: VisionToolExecutor | undefined;
    try {
      const visionRuntime = getVisionProviderRuntime();
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
      new ImageToolExecutor(store, getImageJobQueue(), imageRuntime && {
        provider: imageRuntime.providerName,
        model: imageRuntime.model,
        profile: imageRuntime.profile,
        profileVersion: imageRuntime.profileVersion,
      }),
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
        errorCode: isAgentError(error)
          ? error.code
          : AGENT_ERROR_CODES.providerInterrupted,
        errorMessage: isAgentError(error)
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
  }
}

async function dispatchPendingImageJob(
  run: AgentRunRecord,
): Promise<void> {
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
