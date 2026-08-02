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
  const createdAssets: Array<{
    id: string;
    pathname: string;
  }> = [];

  try {
    const generated = await dependencies.provider.generate({
      prompt: run.prompt,
      count: run.requestedCount,
      size: parseImageSize(run.size),
      model: run.model,
    });

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

    await completeSuccessfulImageTool(
      run,
      result,
      dependencies.agentStore,
    );

    await markImageJobSucceeded({
      imageJobId: job.id,
      leaseId: job.leaseId!,
      providerJobId: generated.providerJobId,
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
      await completeFailedImageTool(
        run,
        imageError,
        dependencies.agentStore,
      );
      return;
    }

    // 只有可重试失败才把异常交回 Vercel Queue。Queue 会按 vercel.json
    // 中的 retryAfterSeconds 重新投递；永久失败已经完成事实落库，必须确认。
    throw imageError;
  }
}

function resolveDependencies(
  overrides?: ImageWorkerDependencies,
): {
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
    await tx
      .delete(projectAssets)
      .where(inArray(projectAssets.id, assets.map((asset) => asset.id)));
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

function parseImageSize(
  value: string,
): GenerateImageArguments["size"] {
  if (
    value === "1024x1024" ||
    value === "1024x1536" ||
    value === "1536x1024"
  ) {
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
