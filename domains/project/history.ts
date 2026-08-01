import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core/session";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

import {
  computeChangeSet,
  computeRestorePlan,
  summarizeChangeSet,
  type ComputedChangeSetFile,
} from "@/domains/project/change-set";
import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";
import type {
  ProjectChangeSet,
  ProjectCheckpoint,
  ProjectRestorePreview,
  ProjectRestoreResult,
  ProjectRevisionManifestEntry,
} from "@/domains/project/types";
import {
  agentRunEvents,
  agentRuns,
  databaseSchema,
  projectChangeSetFiles,
  projectChangeSets,
  projectCheckpoints,
  projectFileBlobs,
  projectFiles,
  projectRevisionFiles,
  projectRevisions,
  projects,
} from "@/infrastructure/db/schema";
import {
  normalizeAgentRunUsage,
  pauseAgentExecution,
} from "@/domains/agent/types";

type RelationalSchema = ExtractTablesWithRelations<typeof databaseSchema>;
type DatabaseLike<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  typeof databaseSchema,
  RelationalSchema
>;
type TransactionLike<TQueryResult extends PgQueryResultHKT> = PgTransaction<
  TQueryResult,
  typeof databaseSchema,
  RelationalSchema
>;

export class ProjectHistoryService<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: DatabaseLike<TQueryResult>) {}

  /**
   * ChangeSet 正文按 hash 回查 blob。数据库表只保存 manifest 与 before/after
   * hash，因此相同内容不会因 Run 数量增加而重复存储。
   */
  async getRunChangeSet(input: {
    ownerId: string;
    runId: string;
  }): Promise<ProjectChangeSet> {
    const changeSet = await selectOwnedChangeSet(this.db, input);
    return hydrateChangeSet(this.db, changeSet);
  }

  async previewRestore(input: {
    ownerId: string;
    runId: string;
  }): Promise<ProjectRestorePreview> {
    const changeSet = await selectOwnedChangeSet(this.db, input);
    const [project] = await this.db
      .select({ revision: projects.revision })
      .from(projects)
      .where(
        and(
          eq(projects.id, changeSet.projectId),
          eq(projects.ownerId, input.ownerId),
          isNull(projects.deletedAt),
        ),
      );

    if (!project) {
      throwProjectNotFound();
    }

    const changes = await selectComputedChanges(this.db, changeSet.id);
    const currentManifest = await selectCurrentManifest(
      this.db,
      changeSet.projectId,
    );
    const plan = computeRestorePlan(changes, currentManifest);

    return {
      runId: input.runId,
      changeSetId: changeSet.id,
      currentRevision: project.revision,
      impacts: plan.impacts,
      conflicts: plan.conflicts,
      canRestore: plan.conflicts.length === 0,
    };
  }

  /**
   * Restore 在一个事务内完成三方冲突检查、revision CAS、文件反向写入、
   * 新 manifest 与 restore checkpoint 创建。任何一步失败都会整体回滚。
   */
  async restoreRunChangeSet(input: {
    ownerId: string;
    runId: string;
    expectedRevision: number;
  }): Promise<ProjectRestoreResult> {
    return this.db.transaction(async (tx) => {
      const changeSet = await selectOwnedChangeSet(tx, input);
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, changeSet.projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        );

      if (!project) {
        throwProjectNotFound();
      }

      if (project.revision !== input.expectedRevision) {
        throwRevisionConflict(project.revision, input.expectedRevision);
      }

      const changes = await selectComputedChanges(tx, changeSet.id);
      const currentManifest = await selectCurrentManifest(tx, project.id);
      const plan = computeRestorePlan(changes, currentManifest);

      if (plan.conflicts.length > 0) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.restoreConflict,
          "部分文件在 Agent 完成后又被修改，恢复操作已取消。",
          409,
          {
            expectedRevision: input.expectedRevision,
            conflicts: plan.conflicts,
          },
        );
      }

      const requiredHashes = [
        ...new Set(
          plan.impacts.flatMap((impact) =>
            impact.action === "write" && impact.restoreHash
              ? [impact.restoreHash]
              : [],
          ),
        ),
      ];
      const availableHashes =
        requiredHashes.length === 0
          ? []
          : await tx
              .select({ hash: projectFileBlobs.hash })
              .from(projectFileBlobs)
              .where(inArray(projectFileBlobs.hash, requiredHashes));

      if (availableHashes.length !== requiredHashes.length) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.checkpointContentMissing,
          "Checkpoint 引用的文件内容不完整，无法安全恢复。",
          409,
          {
            missingHashes: requiredHashes.filter(
              (hash) => !availableHashes.some((row) => row.hash === hash),
            ),
          },
        );
      }

      const [advanced] = await tx
        .update(projects)
        .set({
          revision: sql`${projects.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
            eq(projects.revision, input.expectedRevision),
          ),
        )
        .returning({ revision: projects.revision });

      if (!advanced) {
        const [latest] = await tx
          .select({ revision: projects.revision })
          .from(projects)
          .where(eq(projects.id, project.id));
        throwRevisionConflict(
          latest?.revision ?? project.revision,
          input.expectedRevision,
        );
      }

      const now = new Date();
      for (const impact of plan.impacts) {
        if (impact.action === "none") {
          continue;
        }

        if (impact.action === "delete") {
          await tx
            .update(projectFiles)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(
                eq(projectFiles.projectId, project.id),
                eq(projectFiles.path, impact.path),
                isNull(projectFiles.deletedAt),
              ),
            );
          continue;
        }

        if (!impact.restoreHash) {
          throw new Error("Restore write 缺少目标内容 hash。");
        }

        await tx
          .insert(projectFiles)
          .values({
            projectId: project.id,
            path: impact.path,
            blobHash: impact.restoreHash,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: {
              blobHash: impact.restoreHash,
              deletedAt: null,
              updatedAt: now,
            },
          });
      }

      const revision = input.expectedRevision + 1;
      const [revisionRow] = await tx
        .insert(projectRevisions)
        .values({
          projectId: project.id,
          revision,
          kind: "restore",
          summary: `Restore Agent Run ${input.runId}`,
        })
        .returning({ id: projectRevisions.id });

      if (!revisionRow) {
        throw new Error("创建 restore revision 失败。");
      }

      const restoredManifest = await selectCurrentManifest(tx, project.id);
      if (restoredManifest.length > 0) {
        await tx.insert(projectRevisionFiles).values(
          restoredManifest.map((entry) => ({
            revisionId: revisionRow.id,
            path: entry.path,
            blobHash: entry.hash,
          })),
        );
      }

      const [checkpoint] = await tx
        .insert(projectCheckpoints)
        .values({
          projectId: project.id,
          revisionId: revisionRow.id,
          kind: "restore",
          summary: `恢复 Run r${changeSet.baseRevision} 的文件状态`,
        })
        .returning();

      if (!checkpoint) {
        throw new Error("创建 restore checkpoint 失败。");
      }

      return {
        revision,
        changedPaths: plan.impacts
          .filter((impact) => impact.action !== "none")
          .map((impact) => impact.path),
        checkpoint: toCheckpoint(checkpoint, revision),
      };
    });
  }
}

/**
 * Run 创建事务调用该函数，确保 API 一旦返回 runId，起点 checkpoint 就已经
 * 与 user message、Run、首个事件共同落库。
 */
export async function insertAgentStartCheckpoint<
  TQueryResult extends PgQueryResultHKT,
>(
  tx: TransactionLike<TQueryResult>,
  input: { projectId: string; runId: string; revision: number },
): Promise<void> {
  const revisionId = await requireRevisionId(tx, {
    projectId: input.projectId,
    revision: input.revision,
  });

  await tx.insert(projectCheckpoints).values({
    projectId: input.projectId,
    revisionId,
    runId: input.runId,
    kind: "agent_start",
    summary: `Agent Run 起点 r${input.revision}`,
  });
}

/**
 * 成功收尾采用可重入事务，而不是假设连接中断时数据库一定完整回滚。
 *
 * Neon 连接可能在事务确认阶段中断，极端情况下再次读取时会看到 success
 * checkpoint、ChangeSet 已存在，但 Run 仍停留在 running。这里先锁 Run，
 * 校验并复用已经存在的历史产物，只创建缺失项，最后补齐 Run 终态与事件。
 */
export async function completeSuccessfulAgentRun<
  TQueryResult extends PgQueryResultHKT,
>(
  tx: TransactionLike<TQueryResult>,
  input: { ownerId: string; runId: string },
) {
  const [run] = await tx
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, input.runId), eq(agentRuns.ownerId, input.ownerId)),
    )
    .for("update");

  if (!run) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.projectNotFound,
      "Agent Run 不存在或不属于当前匿名工作区。",
      404,
      { runId: input.runId },
    );
  }

  // 同一个成功收尾请求可能因网络确认丢失而重试。数据库已经是终态时直接
  // 返回事实记录，避免重复 checkpoint、ChangeSet 或状态事件。
  if (run.status === "succeeded") {
    return run;
  }

  if (run.status !== "running") {
    throwHistoryCorrupted(
      "Agent Run 状态与成功历史产物不兼容，不能继续成功收尾。",
      {
        runId: run.id,
        status: run.status,
      },
    );
  }

  const [project] = await tx
    .select({ revision: projects.revision })
    .from(projects)
    .where(
      and(
        eq(projects.id, run.projectId),
        eq(projects.ownerId, run.ownerId),
        isNull(projects.deletedAt),
      ),
    );

  if (!project || project.revision !== run.currentRevision) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.revisionConflict,
      "Agent 验证通过后 Repository revision 已变化，不能创建成功 checkpoint。",
      409,
      {
        expectedRevision: run.currentRevision,
        actualRevision: project?.revision ?? null,
      },
    );
  }

  const baseCheckpoint = await selectRunCheckpoint(tx, {
    runId: run.id,
    kind: "agent_start",
  });

  if (!baseCheckpoint) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.checkpointNotFound,
      "Agent Run 缺少起点 checkpoint，不能标记成功。",
      409,
      { runId: run.id },
    );
  }

  if (
    baseCheckpoint.checkpoint.projectId !== run.projectId ||
    baseCheckpoint.revision !== run.startRevision
  ) {
    throwHistoryCorrupted(
      "Agent 起点 checkpoint 与 Run 的项目或 revision 不一致。",
      {
        runId: run.id,
        checkpointId: baseCheckpoint.checkpoint.id,
        expectedProjectId: run.projectId,
        actualProjectId: baseCheckpoint.checkpoint.projectId,
        expectedRevision: run.startRevision,
        actualRevision: baseCheckpoint.revision,
      },
    );
  }

  const resultRevisionId = await requireRevisionId(tx, {
    projectId: run.projectId,
    revision: run.currentRevision,
  });
  let resultCheckpoint = await selectRunCheckpoint(tx, {
    runId: run.id,
    kind: "agent_success",
  });

  if (resultCheckpoint) {
    if (
      resultCheckpoint.checkpoint.projectId !== run.projectId ||
      resultCheckpoint.checkpoint.revisionId !== resultRevisionId ||
      resultCheckpoint.revision !== run.currentRevision
    ) {
      throwHistoryCorrupted(
        "Agent 成功 checkpoint 与 Run 当前 revision 不一致。",
        {
          runId: run.id,
          checkpointId: resultCheckpoint.checkpoint.id,
          expectedProjectId: run.projectId,
          actualProjectId: resultCheckpoint.checkpoint.projectId,
          expectedRevision: run.currentRevision,
          actualRevision: resultCheckpoint.revision,
        },
      );
    }
  } else {
    const [createdCheckpoint] = await tx
      .insert(projectCheckpoints)
      .values({
        projectId: run.projectId,
        revisionId: resultRevisionId,
        runId: run.id,
        kind: "agent_success",
        summary: `Agent Run 验证成功 r${run.currentRevision}`,
      })
      .returning();

    if (!createdCheckpoint) {
      throw new Error("创建 Agent 成功 checkpoint 失败。");
    }

    resultCheckpoint = {
      checkpoint: createdCheckpoint,
      revision: run.currentRevision,
    };
  }

  const [baseManifest, resultManifest] = await Promise.all([
    selectRevisionManifest(tx, baseCheckpoint.checkpoint.revisionId),
    selectRevisionManifest(tx, resultCheckpoint.checkpoint.revisionId),
  ]);
  const changes = computeChangeSet(baseManifest, resultManifest);
  const expectedSummary = summarizeChangeSet(changes);
  let [changeSet] = await tx
    .select()
    .from(projectChangeSets)
    .where(eq(projectChangeSets.runId, run.id));

  if (changeSet) {
    const hasExpectedIdentity =
      changeSet.projectId === run.projectId &&
      changeSet.baseCheckpointId === baseCheckpoint.checkpoint.id &&
      changeSet.resultCheckpointId === resultCheckpoint.checkpoint.id &&
      changeSet.baseRevision === run.startRevision &&
      changeSet.resultRevision === run.currentRevision &&
      changeSet.summary === expectedSummary;

    if (!hasExpectedIdentity) {
      throwHistoryCorrupted(
        "Agent ChangeSet 与 Run checkpoint 或 revision 不一致。",
        {
          runId: run.id,
          changeSetId: changeSet.id,
        },
      );
    }

    const persistedChanges = await selectComputedChanges(tx, changeSet.id);
    if (!areComputedChangesEqual(persistedChanges, changes)) {
      throwHistoryCorrupted(
        "Agent ChangeSet 文件清单与 revision manifest 不一致。",
        {
          runId: run.id,
          changeSetId: changeSet.id,
          expectedFileCount: changes.length,
          actualFileCount: persistedChanges.length,
        },
      );
    }
  } else {
    [changeSet] = await tx
      .insert(projectChangeSets)
      .values({
        projectId: run.projectId,
        runId: run.id,
        baseCheckpointId: baseCheckpoint.checkpoint.id,
        resultCheckpointId: resultCheckpoint.checkpoint.id,
        baseRevision: run.startRevision,
        resultRevision: run.currentRevision,
        summary: expectedSummary,
      })
      .returning();

    if (!changeSet) {
      throw new Error("创建 Agent ChangeSet 失败。");
    }

    if (changes.length > 0) {
      await tx.insert(projectChangeSetFiles).values(
        changes.map((change, sortOrder) => ({
          changeSetId: changeSet.id,
          ...change,
          sortOrder,
        })),
      );
    }
  }

  const now = new Date();
  // 成功收尾绕过了 AgentStore.transitionRun，因为 checkpoint、ChangeSet 与
  // succeeded 必须同事务提交。因此这里也要显式结束最后一段服务端执行计时。
  const completedUsage = pauseAgentExecution(
    normalizeAgentRunUsage(run.usage),
    now,
  );
  const [updated] = await tx
    .update(agentRuns)
    .set({
      status: "succeeded",
      usage: completedUsage,
      completedAt: now,
      updatedAt: now,
      errorCode: null,
      errorMessage: null,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
    })
    .where(
      and(
        eq(agentRuns.id, run.id),
        eq(agentRuns.ownerId, run.ownerId),
        eq(agentRuns.status, "running"),
      ),
    )
    .returning();

  if (!updated) {
    throw new Error("Agent Run 成功状态写入失败。");
  }

  const statusEvents = await tx
    .select({ payload: agentRunEvents.payload })
    .from(agentRunEvents)
    .where(
      and(
        eq(agentRunEvents.runId, run.id),
        eq(agentRunEvents.type, "run.status_changed"),
      ),
    );
  const hasSucceededEvent = statusEvents.some(
    (event) => event.payload.status === "succeeded",
  );

  if (!hasSucceededEvent) {
    await tx.insert(agentRunEvents).values({
      runId: run.id,
      type: "run.status_changed",
      payload: {
        previousStatus: "running",
        status: "succeeded",
        currentRevision: updated.currentRevision,
        changeSetId: changeSet.id,
      },
    });
  }

  return updated;
}

async function selectRunCheckpoint<TQueryResult extends PgQueryResultHKT>(
  db: TransactionLike<TQueryResult>,
  input: {
    runId: string;
    kind: "agent_start" | "agent_success";
  },
) {
  const [row] = await db
    .select({
      checkpoint: projectCheckpoints,
      revision: projectRevisions.revision,
    })
    .from(projectCheckpoints)
    .innerJoin(
      projectRevisions,
      eq(projectCheckpoints.revisionId, projectRevisions.id),
    )
    .where(
      and(
        eq(projectCheckpoints.runId, input.runId),
        eq(projectCheckpoints.kind, input.kind),
      ),
    );

  return row;
}

function areComputedChangesEqual(
  actual: readonly ComputedChangeSetFile[],
  expected: readonly ComputedChangeSetFile[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((change, index) => {
      const target = expected[index];
      return (
        target !== undefined &&
        change.operation === target.operation &&
        change.pathBefore === target.pathBefore &&
        change.pathAfter === target.pathAfter &&
        change.beforeHash === target.beforeHash &&
        change.afterHash === target.afterHash
      );
    })
  );
}

function throwHistoryCorrupted(
  message: string,
  details: Record<string, unknown>,
): never {
  throw new ProjectError(
    PROJECT_ERROR_CODES.historyCorrupted,
    message,
    409,
    details,
  );
}

async function selectOwnedChangeSet<TQueryResult extends PgQueryResultHKT>(
  db: DatabaseLike<TQueryResult> | TransactionLike<TQueryResult>,
  input: { ownerId: string; runId: string },
) {
  const [changeSet] = await db
    .select({ changeSet: projectChangeSets })
    .from(projectChangeSets)
    .innerJoin(agentRuns, eq(projectChangeSets.runId, agentRuns.id))
    .where(
      and(
        eq(projectChangeSets.runId, input.runId),
        eq(agentRuns.ownerId, input.ownerId),
      ),
    );

  if (!changeSet) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.changeSetNotFound,
      "该 Agent Run 尚无可审查的 ChangeSet。",
      404,
      { runId: input.runId },
    );
  }

  return changeSet.changeSet;
}

async function hydrateChangeSet<TQueryResult extends PgQueryResultHKT>(
  db: DatabaseLike<TQueryResult> | TransactionLike<TQueryResult>,
  changeSet: typeof projectChangeSets.$inferSelect,
): Promise<ProjectChangeSet> {
  const rows = await db
    .select()
    .from(projectChangeSetFiles)
    .where(eq(projectChangeSetFiles.changeSetId, changeSet.id))
    .orderBy(asc(projectChangeSetFiles.sortOrder));
  const hashes = [
    ...new Set(
      rows.flatMap((row) =>
        [row.beforeHash, row.afterHash].filter(
          (hash): hash is string => hash !== null,
        ),
      ),
    ),
  ];
  const blobs =
    hashes.length === 0
      ? []
      : await db
          .select({
            hash: projectFileBlobs.hash,
            content: projectFileBlobs.content,
          })
          .from(projectFileBlobs)
          .where(inArray(projectFileBlobs.hash, hashes));
  const contentByHash = new Map(blobs.map((blob) => [blob.hash, blob.content]));

  if (contentByHash.size !== hashes.length) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.checkpointContentMissing,
      "ChangeSet 引用的文件内容不完整。",
      409,
      {
        missingHashes: hashes.filter((hash) => !contentByHash.has(hash)),
      },
    );
  }

  return {
    id: changeSet.id,
    projectId: changeSet.projectId,
    runId: changeSet.runId,
    baseCheckpointId: changeSet.baseCheckpointId,
    resultCheckpointId: changeSet.resultCheckpointId,
    baseRevision: changeSet.baseRevision,
    resultRevision: changeSet.resultRevision,
    summary: changeSet.summary,
    files: rows.map((row) => ({
      id: row.id,
      operation: row.operation,
      pathBefore: row.pathBefore,
      pathAfter: row.pathAfter,
      beforeHash: row.beforeHash,
      afterHash: row.afterHash,
      beforeContent: row.beforeHash
        ? (contentByHash.get(row.beforeHash) ?? null)
        : null,
      afterContent: row.afterHash
        ? (contentByHash.get(row.afterHash) ?? null)
        : null,
      sortOrder: row.sortOrder,
    })),
    createdAt: changeSet.createdAt.toISOString(),
  };
}

async function selectComputedChanges<TQueryResult extends PgQueryResultHKT>(
  db: DatabaseLike<TQueryResult> | TransactionLike<TQueryResult>,
  changeSetId: string,
): Promise<ComputedChangeSetFile[]> {
  return db
    .select({
      operation: projectChangeSetFiles.operation,
      pathBefore: projectChangeSetFiles.pathBefore,
      pathAfter: projectChangeSetFiles.pathAfter,
      beforeHash: projectChangeSetFiles.beforeHash,
      afterHash: projectChangeSetFiles.afterHash,
    })
    .from(projectChangeSetFiles)
    .where(eq(projectChangeSetFiles.changeSetId, changeSetId))
    .orderBy(asc(projectChangeSetFiles.sortOrder));
}

async function selectRevisionManifest<TQueryResult extends PgQueryResultHKT>(
  db: DatabaseLike<TQueryResult> | TransactionLike<TQueryResult>,
  revisionId: string,
): Promise<ProjectRevisionManifestEntry[]> {
  return db
    .select({
      path: projectRevisionFiles.path,
      hash: projectRevisionFiles.blobHash,
    })
    .from(projectRevisionFiles)
    .where(eq(projectRevisionFiles.revisionId, revisionId))
    .orderBy(asc(projectRevisionFiles.path));
}

async function selectCurrentManifest<TQueryResult extends PgQueryResultHKT>(
  db: DatabaseLike<TQueryResult> | TransactionLike<TQueryResult>,
  projectId: string,
): Promise<ProjectRevisionManifestEntry[]> {
  return db
    .select({ path: projectFiles.path, hash: projectFiles.blobHash })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        isNull(projectFiles.deletedAt),
      ),
    )
    .orderBy(asc(projectFiles.path));
}

async function requireRevisionId<TQueryResult extends PgQueryResultHKT>(
  db: DatabaseLike<TQueryResult> | TransactionLike<TQueryResult>,
  input: { projectId: string; revision: number },
): Promise<string> {
  const [revision] = await db
    .select({ id: projectRevisions.id })
    .from(projectRevisions)
    .where(
      and(
        eq(projectRevisions.projectId, input.projectId),
        eq(projectRevisions.revision, input.revision),
      ),
    );

  if (!revision) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.checkpointContentMissing,
      "目标 revision 缺少完整快照，无法创建 checkpoint。",
      409,
      input,
    );
  }

  return revision.id;
}

function toCheckpoint(
  row: typeof projectCheckpoints.$inferSelect,
  revision: number,
): ProjectCheckpoint {
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    kind: row.kind,
    revision,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

function throwProjectNotFound(): never {
  throw new ProjectError(
    PROJECT_ERROR_CODES.projectNotFound,
    "项目不存在、已删除或不属于当前匿名工作区。",
    404,
  );
}

function throwRevisionConflict(
  actualRevision: number,
  expectedRevision: number,
): never {
  throw new ProjectError(
    PROJECT_ERROR_CODES.revisionConflict,
    "项目 revision 已变化，请重新检查恢复影响。",
    409,
    { actualRevision, expectedRevision },
  );
}
