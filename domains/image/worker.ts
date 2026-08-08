import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import type { AgentStore } from "@/domains/agent/store";
import type { AgentRunRecord } from "@/domains/agent/types";
import type { GenerateImageArguments } from "@/domains/image/generation";
import type { ImageProvider } from "@/domains/image/generation";
import { launchAgentRun } from "@/infrastructure/agent/runtime";
import {
  getPrivateBlobStore,
  type PrivateBlobStore,
} from "@/infrastructure/blob/private-store";
import { getImageProviderRuntime } from "@/infrastructure/image/image-provider-factory";
import {
  claimImageJob,
  markImageJobFailure,
  markImageJobSucceeded,
} from "@/domains/image/job-store";
import {
  IMAGE_ERROR_CODES,
  ImageError,
  isImageError,
} from "@/domains/image/errors";
import {
  validateGeneratedImage,
  buildGeneratedImagePathname,
} from "@/domains/image/validation";
import {
  imageRuns,
  projectAssets,
  toolInvocations,
  agentRunEvents,
  transcriptMessages,
} from "@/infrastructure/db/schema";
import {
  getDatabase,
  runDatabaseTransaction,
} from "@/infrastructure/db/client";
import { getAgentPersistence } from "@/infrastructure/http/agent-api";
import {
  isGlobalBudgetEnabled,
  recordImageUsage,
  reserveImageUsageBudget,
  releaseQuotaReservation,
  settleImageUsageBudget,
  type UsageBudgetReservation,
} from "@/infrastructure/quota/service";

const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;

type ImageWorkerAgentStore = Pick<
  AgentStore<PgQueryResultHKT>,
  "getRun" | "transitionRun"
>;

export type ImageWorkerDependencies = {
  /**
   * 测试可以注入 fake Provider、Blob 和 Agent Store，验证异步状态机而不
   * 依赖线上图片模型或私有存储。生产调用不传该字段，继续使用默认工厂。
   */
  provider?: ImageProvider;
  blobStore?: PrivateBlobStore;
  agentStore?: ImageWorkerAgentStore;
  launchAgentRun?: typeof launchAgentRun;
};

export async function processNextImageJob(input?: {
  expectedJobId?: string;
  expectedImageRunId?: string;
  dependencies?: ImageWorkerDependencies;
}): Promise<void> {
  // 先解析依赖，再领取租约。配置错误属于“当前环境不可执行”，不能让
  // 已经领取的 job 卡在 running，等待租约过期后才被动恢复。
  const dependencies = resolveDependencies(input?.dependencies);
  const claimed = await claimImageJob({
    expectedJobId: input?.expectedJobId,
    expectedImageRunId: input?.expectedImageRunId,
  });
  if (!claimed) {
    return;
  }

  const { job, run } = claimed;
  if (claimed.finalized) {
    // 达到最大重试次数时，claimImageJob 已经提交了 image job/run 终态并
    // 释放了图片并发租约。这里补齐父 Agent 的 Tool Ledger 和 transcript，
    // 避免父 Run 永久停留在 awaiting_async_job。
    await completeFailedImageTool(
      run,
      new ImageError(
        IMAGE_ERROR_CODES.generationFailed,
        run.errorMessage ?? "图片生成任务已达到最大重试次数。",
        502,
        run.errorCode ? { persistedErrorCode: run.errorCode } : undefined,
      ),
      dependencies.agentStore,
    );
    return;
  }

  const createdAssets: Array<{
    id: string;
    pathname: string;
  }> = [];
  let budgetReservation: UsageBudgetReservation | null = null;
  let providerRequestStarted = false;
  let providerResponseReceived = false;

  try {
    // 生图费用必须在 Provider 请求前预留。attempt 纳入幂等键，
    // 因此队列重复投递不会重复占用同一次 Provider 调用的预算。
    budgetReservation = await reserveImageUsageBudget({
      ownerId: run.ownerId,
      imageRunId: run.id,
      provider: run.provider,
      model: run.model,
      count: run.requestedCount,
      size: run.size,
      attempt: job.attempt,
    });

    // ImageProvider 当前没有显式 request_started 事件。generate() 是唯一的
    // 外部请求入口，因此调用前标记为 started；即使上游响应前超时，也按
    // “供应商可能已收费”处理，避免真实账单与本地账本不一致。
    providerRequestStarted = true;
    const generated = await dependencies.provider.generate({
      prompt: run.prompt,
      count: run.requestedCount,
      size: parseImageSize(run.size),
      model: run.model,
    });
    providerResponseReceived = true;

    if (generated.images.length !== run.requestedCount) {
      throw new ImageError(
        IMAGE_ERROR_CODES.generationInvalidResponse,
        "Image Provider 返回的图片数量与请求不一致。",
        502,
        {
          requestedCount: run.requestedCount,
          receivedCount: generated.images.length,
        },
      );
    }

    const store = dependencies.blobStore;
    const assets: Array<{
      id: string;
      pathname: string;
    }> = [];

    for (const [index, image] of generated.images.entries()) {
      const validated = validateGeneratedImage({
        bytes: image.bytes,
        mimeType: image.mimeType,
        originalFilename: `generated-${index + 1}`,
      });

      if (validated.byteLength > MAX_GENERATED_IMAGE_BYTES) {
        throw new ImageError(
          IMAGE_ERROR_CODES.fileTooLarge,
          "Image Provider 返回的图片超过大小限制。",
          413,
        );
      }

      const asset = await persistGeneratedAsset({
        run,
        index,
        image,
        validated,
        store,
      });
      assets.push({ id: asset.id, pathname: asset.pathname });
      if (asset.created) {
        createdAssets.push({ id: asset.id, pathname: asset.pathname });
      }
    }

    const assetRows = await getDatabase()
      .select({ id: projectAssets.id })
      .from(projectAssets)
      .where(eq(projectAssets.imageRunId, run.id))
      .orderBy(asc(projectAssets.generationIndex));

    const result = {
      ok: true,
      toolName: "generate_image",
      revision: await getParentRevision(run, dependencies.agentStore),
      data: {
        imageRunId: run.id,
        assetCount: assetRows.length,
        assetIds: assetRows.map((asset) => asset.id),
      },
    };

    await completeSuccessfulImageTool(run, result, dependencies.agentStore);

    await markImageJobSucceeded({
      imageJobId: job.id,
      leaseId: job.leaseId!,
      providerJobId: generated.providerJobId,
    });
    await settleImageQuotaAndUsage({
      run,
      providerJobId: generated.providerJobId,
      attempt: job.attempt,
      budgetReservation,
      providerRequestStarted,
      providerResponseReceived,
    });

    const parent = await getParentRun(run, dependencies.agentStore);
    if (
      parent &&
      parent.status === "awaiting_async_job" &&
      !parent.cancellationRequestedAt
    ) {
      await dependencies.agentStore.transitionRun({
        ownerId: run.ownerId,
        runId: parent.id,
        status: "running",
      });
      await dependencies.launchAgentRun({
        ownerId: run.ownerId,
        runId: parent.id,
      });
    }
  } catch (error) {
    await cleanupCreatedAssets(createdAssets, dependencies.blobStore);
    const imageError = normalizeImageError(error);
    const retryable = isRetryableImageError(imageError);
    let outcome: { retryScheduled: boolean };
    try {
      outcome = await markImageJobFailure({
        imageJobId: job.id,
        leaseId: job.leaseId!,
        errorCode: imageError.code,
        errorMessage: imageError.message,
        retryable,
      });
    } catch (leaseError) {
      // 旧 Worker 可能在 Provider 调用期间失去租约。此时不能覆盖新执行器
      // 的状态，也不能让队列因为一个迟到的提交再次制造错误重试。
      console.warn("[image-worker] lease lost", leaseError);
      return;
    }

    if (!outcome.retryScheduled) {
      await settleImageQuotaAndUsage({
        run,
        attempt: job.attempt,
        status: "settled",
        budgetReservation,
        providerRequestStarted,
        providerResponseReceived,
      });
      await completeFailedImageTool(run, imageError, dependencies.agentStore);
      return;
    }

    // 可重试失败也要先结算当前 attempt。下一次重试是新的 Provider 请求，
    // 使用新的幂等键和新的预算预留，不能让本次 reservation 一直悬挂。
    await settleImageQuotaAndUsage({
      run,
      attempt: job.attempt,
      status: "settled",
      budgetReservation,
      providerRequestStarted,
      providerResponseReceived,
    });

    // 只有可重试失败才把异常交回 Vercel Queue。Queue 会按 vercel.json
    // 中的 retryAfterSeconds 重新投递；永久失败已经完成事实落库，必须确认。
    throw imageError;
  }
}

async function settleImageQuotaAndUsage(input: {
  run: typeof imageRuns.$inferSelect;
  providerJobId?: string;
  attempt: number;
  status?: "settled";
  budgetReservation: UsageBudgetReservation | null;
  providerRequestStarted: boolean;
  providerResponseReceived: boolean;
}): Promise<void> {
  // Worker 的状态提交已经完成后才释放并发租约。两个操作均为幂等，
  // 释放失败只记录日志，不把已经写入的业务终态改成内部错误。
  try {
    await releaseQuotaReservation({
      resource: "image_generation",
      resourceId: input.run.id,
    });
  } catch (error) {
    console.error("[image-worker] image quota release failed", {
      imageRunId: input.run.id,
      error,
    });
  }

  try {
    if (input.budgetReservation || isGlobalBudgetEnabled()) {
      await settleImageUsageBudget({
        reservation: input.budgetReservation,
        providerRequestStarted: input.providerRequestStarted,
        providerResponseReceived: input.providerResponseReceived,
        providerJobId: input.providerJobId,
      });
    } else {
      await recordImageUsage({
        ownerId: input.run.ownerId,
        imageRunId: input.run.id,
        provider: input.run.provider,
        model: input.run.model,
        count: input.run.requestedCount,
        size: input.run.size,
        providerJobId: input.providerJobId,
        attempt: input.attempt,
        status: input.status ?? "settled",
      });
    }
  } catch (error) {
    // 业务终态已经先写入，账务失败不能把队列变成无限重试；
    // 这里保留结构化日志，后续由账务对账任务或告警补偿。
    console.error("[image-worker] image usage settlement failed", {
      imageRunId: input.run.id,
      attempt: input.attempt,
      error,
    });
  }
}

function resolveDependencies(overrides?: ImageWorkerDependencies): {
  provider: ImageProvider;
  blobStore: PrivateBlobStore;
  agentStore: ImageWorkerAgentStore;
  launchAgentRun: typeof launchAgentRun;
} {
  return {
    provider: overrides?.provider ?? getImageProviderRuntime().provider,
    blobStore: overrides?.blobStore ?? getPrivateBlobStore(),
    agentStore: overrides?.agentStore ?? getAgentPersistence().store,
    launchAgentRun: overrides?.launchAgentRun ?? launchAgentRun,
  };
}

async function completeFailedImageTool(
  run: typeof imageRuns.$inferSelect,
  error: ImageError,
  agentStore: ImageWorkerAgentStore,
): Promise<void> {
  const parent = await getParentRun(run, agentStore);
  const result = {
    ok: false,
    toolName: "generate_image",
    revision: parent?.currentRevision ?? 0,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };

  await runDatabaseTransaction(async (tx) => {
    const [invocation] = await tx
      .select({
        id: toolInvocations.id,
        status: toolInvocations.status,
      })
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.runId, run.parentAgentRunId ?? ""),
          eq(toolInvocations.toolCallId, run.toolCallId),
          eq(toolInvocations.status, "running"),
        ),
      )
      .limit(1);

    if (!invocation || invocation.status !== "running") {
      return;
    }

    await tx
      .update(toolInvocations)
      .set({
        status: parent?.cancellationRequestedAt ? "cancelled" : "failed",
        resultJson: result,
        errorCode: error.code,
        revisionAfter: result.revision,
        completedAt: new Date(),
      })
      .where(eq(toolInvocations.id, invocation.id));

    if (run.conversationId && run.parentAgentRunId) {
      await tx.insert(transcriptMessages).values({
        conversationId: run.conversationId,
        runId: run.parentAgentRunId,
        role: "tool",
        kind: "tool_result",
        payload: {
          toolCallId: run.toolCallId,
          toolName: "generate_image",
          resultJson: result,
        },
      });

      await tx.insert(agentRunEvents).values({
        runId: run.parentAgentRunId,
        type: "tool.completed",
        payload: {
          toolCallId: run.toolCallId,
          toolName: "generate_image",
          ok: false,
          revision: result.revision,
          errorCode: error.code,
        },
      });
    }
  });

  if (
    parent &&
    parent.status === "awaiting_async_job" &&
    !parent.cancellationRequestedAt
  ) {
    await agentStore.transitionRun({
      ownerId: run.ownerId,
      runId: parent.id,
      status: "failed",
      errorCode: error.code,
      errorMessage: error.message,
    });
  }
}

async function completeSuccessfulImageTool(
  run: typeof imageRuns.$inferSelect,
  result: Record<string, unknown>,
  agentStore: ImageWorkerAgentStore,
): Promise<void> {
  const parent = await getParentRun(run, agentStore);

  await runDatabaseTransaction(async (tx) => {
    const [invocation] = await tx
      .select({
        id: toolInvocations.id,
        status: toolInvocations.status,
      })
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.runId, run.parentAgentRunId ?? ""),
          eq(toolInvocations.toolCallId, run.toolCallId),
        ),
      )
      .limit(1);

    if (!invocation || invocation.status !== "running") {
      return;
    }

    await tx
      .update(toolInvocations)
      .set({
        status: parent?.cancellationRequestedAt ? "cancelled" : "succeeded",
        resultJson: result,
        revisionAfter:
          typeof result.revision === "number" ? result.revision : undefined,
        completedAt: new Date(),
      })
      .where(eq(toolInvocations.id, invocation.id));

    if (!run.conversationId || !run.parentAgentRunId) {
      return;
    }

    await tx.insert(transcriptMessages).values({
      conversationId: run.conversationId,
      runId: run.parentAgentRunId,
      role: "tool",
      kind: "tool_result",
      payload: {
        toolCallId: run.toolCallId,
        toolName: "generate_image",
        resultJson: result,
      },
    });

    await tx.insert(agentRunEvents).values({
      runId: run.parentAgentRunId,
      type: "tool.completed",
      payload: {
        toolCallId: run.toolCallId,
        toolName: "generate_image",
        ok: true,
        revision: result.revision,
      },
    });
  });
}

async function persistGeneratedAsset(input: {
  run: typeof imageRuns.$inferSelect;
  index: number;
  image: {
    bytes: Uint8Array;
    mimeType: string;
    providerImageId?: string;
  };
  validated: ReturnType<typeof validateGeneratedImage>;
  store: ReturnType<typeof getPrivateBlobStore>;
}): Promise<{ id: string; pathname: string; created: boolean }> {
  const existing = await findGeneratedAsset(input.run.id, input.index);
  if (existing) {
    return {
      id: existing.id,
      pathname: existing.blobPathname,
      created: false,
    };
  }

  const pathname = buildGeneratedImagePathname({
    ownerId: input.run.ownerId,
    projectId: input.run.projectId,
    imageRunId: input.run.id,
    generationIndex: input.index,
    format: input.validated.format,
  });
  const blob = await input.store.put(
    pathname,
    input.validated.bytes,
    input.validated.mimeType,
  );
  const assetId = randomUUID();

  try {
    const inserted = await runDatabaseTransaction(async (tx) =>
      tx
        .insert(projectAssets)
        .values({
          id: assetId,
          ownerId: input.run.ownerId,
          projectId: input.run.projectId,
          imageRunId: input.run.id,
          generationIndex: input.index,
          kind: "generated_image",
          source: "image_generation",
          originalFilename: `generated-${input.index + 1}.${input.validated.format === "jpeg" ? "jpg" : input.validated.format}`,
          mimeType: input.validated.mimeType,
          byteLength: input.validated.byteLength,
          sha256: input.validated.sha256,
          blobPathname: blob.pathname,
          blobUrl: blob.url,
          width: input.validated.width,
          height: input.validated.height,
          metadata: {
            provider: input.run.provider,
            model: input.run.model,
            imageRunId: input.run.id,
            generationIndex: input.index,
            providerImageId: input.image.providerImageId ?? null,
          },
        })
        .onConflictDoNothing()
        .returning({ id: projectAssets.id }),
    );

    if (inserted[0]) {
      return { id: assetId, pathname: blob.pathname, created: true };
    }
  } catch (error) {
    await deleteBlobQuietly(input.store, blob.pathname);
    throw error;
  }

  const concurrentAsset = await findGeneratedAsset(input.run.id, input.index);
  if (concurrentAsset) {
    await deleteBlobQuietly(input.store, blob.pathname);
    return {
      id: concurrentAsset.id,
      pathname: concurrentAsset.blobPathname,
      created: false,
    };
  }

  throw new ImageError(
    IMAGE_ERROR_CODES.generationFailed,
    "图片资产写入发生冲突，且无法读取已存在的资产。",
    409,
  );
}

async function findGeneratedAsset(imageRunId: string, generationIndex: number) {
  const [asset] = await getDatabase()
    .select({
      id: projectAssets.id,
      blobPathname: projectAssets.blobPathname,
    })
    .from(projectAssets)
    .where(
      and(
        eq(projectAssets.imageRunId, imageRunId),
        eq(projectAssets.generationIndex, generationIndex),
      ),
    )
    .limit(1);
  return asset ?? null;
}

async function cleanupCreatedAssets(
  assets: Array<{ id: string; pathname: string }>,
  store: PrivateBlobStore,
): Promise<void> {
  if (assets.length === 0) {
    return;
  }

  await runDatabaseTransaction(async (tx) => {
    await tx.delete(projectAssets).where(
      inArray(
        projectAssets.id,
        assets.map((asset) => asset.id),
      ),
    );
  });

  await Promise.all(
    assets.map(async (asset) => {
      await deleteBlobQuietly(store, asset.pathname);
    }),
  );
}

async function deleteBlobQuietly(
  store: ReturnType<typeof getPrivateBlobStore>,
  pathname: string,
): Promise<void> {
  await store.del(pathname).catch((error) => {
    console.warn("[image-worker] failed to clean generated blob", {
      pathname,
      error,
    });
  });
}

async function getParentRun(
  run: typeof imageRuns.$inferSelect,
  agentStore: ImageWorkerAgentStore,
): Promise<AgentRunRecord | null> {
  if (!run.parentAgentRunId) {
    return null;
  }

  return agentStore.getRun({
    ownerId: run.ownerId,
    runId: run.parentAgentRunId,
  });
}

async function getParentRevision(
  run: typeof imageRuns.$inferSelect,
  agentStore: ImageWorkerAgentStore,
): Promise<number> {
  const parent = await getParentRun(run, agentStore);
  return parent?.currentRevision ?? 0;
}

function parseImageSize(value: string): GenerateImageArguments["size"] {
  if (value === "1024x1024" || value === "1024x1536" || value === "1536x1024") {
    return value;
  }

  throw new ImageError(
    IMAGE_ERROR_CODES.generationInvalidResponse,
    "数据库中的图片尺寸不受支持。",
    500,
    { size: value },
  );
}

function normalizeImageError(error: unknown): ImageError {
  if (isImageError(error)) {
    return error;
  }

  return new ImageError(
    IMAGE_ERROR_CODES.generationFailed,
    "图片生成任务执行失败。",
    502,
    { cause: error instanceof Error ? error.message : String(error) },
  );
}

function isRetryableImageError(error: ImageError): error is ImageError & {
  code:
    | typeof IMAGE_ERROR_CODES.generationTimeout
    | typeof IMAGE_ERROR_CODES.generationFailed
    | typeof IMAGE_ERROR_CODES.blobUnavailable
    | typeof IMAGE_ERROR_CODES.storageWriteFailed;
} {
  return (
    error.code === IMAGE_ERROR_CODES.generationTimeout ||
    error.code === IMAGE_ERROR_CODES.generationFailed ||
    error.code === IMAGE_ERROR_CODES.blobUnavailable ||
    error.code === IMAGE_ERROR_CODES.storageWriteFailed
  );
}
