import "server-only";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import { imageJobs, imageRuns, projects } from "@/infrastructure/db/schema";
import {
  getDatabase,
  runDatabaseTransaction,
} from "@/infrastructure/db/client";
import {
  isGlobalBudgetEnabled,
  recordImageUsage,
  releaseQuotaReservation,
} from "@/infrastructure/quota/service";

export const IMAGE_JOB_LEASE_MS = 120_000;
export const IMAGE_JOB_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export type ClaimedImageJob = {
  job: typeof imageJobs.$inferSelect;
  run: typeof imageRuns.$inferSelect;
  /**
   * true 表示任务已经在领取事务中完成最终失败收口。
   * Worker 仍需要据此补写父 Agent 的 async tool ledger。
   */
  finalized?: boolean;
};

/**
 * image_jobs 是异步生图的事实记录。
 *
 * 每次消费都先通过 PostgreSQL 行锁领取租约，再调用外部 Provider。这样
 * Vercel Queue 重复投递、用户刷新恢复和本地保底队列可以安全地同时触发，
 * 但最终只有持有 leaseId 的执行器能提交状态变化。
 */
export async function claimImageJob(input?: {
  expectedJobId?: string;
  expectedImageRunId?: string;
  now?: Date;
}): Promise<ClaimedImageJob | null> {
  const now = input?.now ?? new Date();
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + IMAGE_JOB_LEASE_MS);

  const result = await runDatabaseTransaction(async (tx) => {
    const [candidate] = await tx
      .select({
        job: imageJobs,
        run: imageRuns,
      })
      .from(imageJobs)
      .innerJoin(imageRuns, eq(imageRuns.id, imageJobs.imageRunId))
      .innerJoin(
        projects,
        and(
          eq(projects.id, imageJobs.projectId),
          eq(projects.ownerId, imageJobs.ownerId),
          isNull(projects.deletedAt),
        ),
      )
      .where(
        and(
          input?.expectedJobId
            ? eq(imageJobs.id, input.expectedJobId)
            : undefined,
          input?.expectedImageRunId
            ? eq(imageJobs.imageRunId, input.expectedImageRunId)
            : undefined,
          or(
            and(
              or(
                eq(imageJobs.status, "queued"),
                eq(imageJobs.status, "retryable"),
              ),
              or(
                sql`${imageJobs.nextAttemptAt} is null`,
                lte(imageJobs.nextAttemptAt, now),
              ),
            ),
            and(
              eq(imageJobs.status, "running"),
              sql`${imageJobs.leaseExpiresAt} is not null`,
              lte(imageJobs.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(imageJobs.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) {
      return { claimed: null, finalized: null };
    }

    if (candidate.job.attempt >= candidate.job.maxAttempts) {
      const [failedJob] = await tx
        .update(imageJobs)
        .set({
          status: "failed",
          errorCode: IMAGE_ERROR_CODES.generationFailed,
          errorMessage: "图片生成任务已达到最大重试次数。",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(imageJobs.id, candidate.job.id))
        .returning();

      const [failedRun] = failedJob
        ? await tx
            .update(imageRuns)
            .set({
              status: "failed",
              errorCode: IMAGE_ERROR_CODES.generationFailed,
              errorMessage: "图片生成任务已达到最大重试次数。",
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(imageRuns.id, candidate.run.id))
            .returning()
        : [];
      return {
        claimed:
          failedJob && failedRun
            ? {
                job: failedJob,
                run: failedRun,
                finalized: true,
              }
            : null,
        finalized: {
          ownerId: candidate.run.ownerId,
          imageRunId: candidate.run.id,
          provider: candidate.run.provider,
          model: candidate.run.model,
          count: candidate.run.requestedCount,
          size: candidate.run.size,
          attempt: candidate.job.attempt,
        },
      };
    }

    const [updatedJob] = await tx
      .update(imageJobs)
      .set({
        status: "running",
        attempt: candidate.job.attempt + 1,
        leaseId,
        leaseExpiresAt,
        startedAt: candidate.job.startedAt ?? now,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imageJobs.id, candidate.job.id),
          or(
            eq(imageJobs.status, "queued"),
            eq(imageJobs.status, "retryable"),
            and(
              eq(imageJobs.status, "running"),
              lte(imageJobs.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .returning();

    if (!updatedJob) {
      return { claimed: null, finalized: null };
    }

    const [updatedRun] = await tx
      .update(imageRuns)
      .set({
        status: "running",
        startedAt: candidate.run.startedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(imageRuns.id, candidate.run.id),
          or(eq(imageRuns.status, "queued"), eq(imageRuns.status, "running")),
        ),
      )
      .returning();

    return {
      claimed: {
        job: updatedJob,
        run: updatedRun ?? candidate.run,
      },
      finalized: null,
    };
  });

  if (result.finalized) {
    // 达到最大重试次数的任务不会再进入 Worker，因此这里补上最后一次
    // 额度释放和 usage 事实记录，避免永久占用 image_generation lease。
    try {
      await releaseQuotaReservation({
        resource: "image_generation",
        resourceId: result.finalized.imageRunId,
      });
    } catch (error) {
      console.error("[image-job-store] image quota release failed", {
        imageRunId: result.finalized.imageRunId,
        error,
      });
    }
    // 达到最大重试次数但没有再次发起 Provider 请求时，只需结束旧的
    // 兼容账本；预算账本不存在本次 attempt 的 reservation，不应虚构成本。
    try {
      if (!isGlobalBudgetEnabled()) {
        await recordImageUsage({
          ownerId: result.finalized.ownerId,
          imageRunId: result.finalized.imageRunId,
          provider: result.finalized.provider,
          model: result.finalized.model,
          count: result.finalized.count,
          size: result.finalized.size,
          attempt: result.finalized.attempt,
          status: "settled",
        });
      }
    } catch (error) {
      console.error("[image-job-store] image usage settlement failed", {
        imageRunId: result.finalized.imageRunId,
        error,
      });
    }
  }

  return result.claimed;
}

export async function getImageJob(input: {
  imageJobId: string;
}): Promise<ClaimedImageJob | null> {
  const [row] = await getDatabase()
    .select({ job: imageJobs, run: imageRuns })
    .from(imageJobs)
    .innerJoin(imageRuns, eq(imageRuns.id, imageJobs.imageRunId))
    .where(eq(imageJobs.id, input.imageJobId))
    .limit(1);

  return row ?? null;
}

/**
 * 通过父 Agent Run 找到尚未完成的图片任务。
 *
 * 恢复请求可能重复到达，因此这里只返回仍处于可投递状态的 job；
 * running job 由原执行器或租约过期后的下一次消费负责处理。
 */
export async function getPendingImageJobForAgentRun(input: {
  ownerId: string;
  agentRunId: string;
}): Promise<ClaimedImageJob | null> {
  const [row] = await getDatabase()
    .select({ job: imageJobs, run: imageRuns })
    .from(imageJobs)
    .innerJoin(imageRuns, eq(imageRuns.id, imageJobs.imageRunId))
    .where(
      and(
        eq(imageRuns.ownerId, input.ownerId),
        eq(imageRuns.parentAgentRunId, input.agentRunId),
        or(eq(imageJobs.status, "queued"), eq(imageJobs.status, "retryable")),
      ),
    )
    .orderBy(imageJobs.createdAt)
    .limit(1);

  return row ?? null;
}

export async function markImageJobSucceeded(input: {
  imageJobId: string;
  leaseId: string;
  providerJobId?: string;
}): Promise<void> {
  const now = new Date();
  await runDatabaseTransaction(async (tx) => {
    const [current] = await tx
      .select({
        id: imageJobs.id,
        imageRunId: imageJobs.imageRunId,
        projectId: imageJobs.projectId,
        ownerId: imageJobs.ownerId,
      })
      .from(imageJobs)
      .where(
        and(
          eq(imageJobs.id, input.imageJobId),
          eq(imageJobs.status, "running"),
          eq(imageJobs.leaseId, input.leaseId),
        ),
      )
      .for("update");

    if (!current) {
      throw new ImageError(
        IMAGE_ERROR_CODES.generationJobNotFound,
        "图片任务租约已失效，无法提交成功结果。",
        409,
      );
    }

    // 项目删除与 Worker 完成共用项目行锁。只有项目仍然 active，当前租约
    // 才能把 image job/run 提交为成功；否则删除事务保留 cancelled 事实。
    const [activeProject] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, current.projectId),
          eq(projects.ownerId, current.ownerId),
          isNull(projects.deletedAt),
        ),
      )
      .for("update");

    if (!activeProject) {
      throw new ImageError(
        IMAGE_ERROR_CODES.generationJobNotFound,
        "项目已删除，图片任务不能提交成功结果。",
        409,
      );
    }

    const [job] = await tx
      .update(imageJobs)
      .set({
        status: "succeeded",
        providerJobId: input.providerJobId,
        leaseId: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(imageJobs.id, current.id),
          eq(imageJobs.status, "running"),
          eq(imageJobs.leaseId, input.leaseId),
        ),
      )
      .returning({ imageRunId: imageJobs.imageRunId });

    const [completedRun] = await tx
      .update(imageRuns)
      .set({
        status: "succeeded",
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(imageRuns.id, job.imageRunId), eq(imageRuns.status, "running")),
      )
      .returning({ id: imageRuns.id });

    if (!completedRun) {
      throw new ImageError(
        IMAGE_ERROR_CODES.generationJobNotFound,
        "图片任务状态已变化，无法提交成功结果。",
        409,
      );
    }
  });
}

export async function markImageJobFailure(input: {
  imageJobId: string;
  leaseId: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}): Promise<{ retryScheduled: boolean }> {
  const now = new Date();

  return runDatabaseTransaction(async (tx) => {
    const [current] = await tx
      .select({
        id: imageJobs.id,
        imageRunId: imageJobs.imageRunId,
        attempt: imageJobs.attempt,
        maxAttempts: imageJobs.maxAttempts,
      })
      .from(imageJobs)
      .where(
        and(
          eq(imageJobs.id, input.imageJobId),
          eq(imageJobs.status, "running"),
          eq(imageJobs.leaseId, input.leaseId),
        ),
      )
      .for("update");

    if (!current) {
      throw new ImageError(
        IMAGE_ERROR_CODES.generationJobNotFound,
        "图片任务租约已失效，无法提交失败结果。",
        409,
      );
    }

    const canRetry =
      input.retryable &&
      current.attempt < current.maxAttempts &&
      current.attempt <= IMAGE_JOB_RETRY_DELAYS_MS.length;
    const retryDelay =
      IMAGE_JOB_RETRY_DELAYS_MS[Math.max(0, current.attempt - 1)] ??
      IMAGE_JOB_RETRY_DELAYS_MS.at(-1)!;
    const nextAttemptAt = canRetry
      ? new Date(now.getTime() + retryDelay)
      : null;

    await tx
      .update(imageJobs)
      .set({
        status: canRetry ? "retryable" : "failed",
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: canRetry ? null : now,
        updatedAt: now,
      })
      .where(eq(imageJobs.id, current.id));

    if (canRetry) {
      await tx
        .update(imageRuns)
        .set({
          status: "running",
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(imageRuns.id, current.imageRunId));
    } else {
      await tx
        .update(imageRuns)
        .set({
          status: "failed",
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(imageRuns.id, current.imageRunId));
    }

    return { retryScheduled: canRetry };
  });
}
