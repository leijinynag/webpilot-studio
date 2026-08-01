import { and, eq, sql, type SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentStore } from "@/domains/agent/store";
import type { FrozenAgentRunProfile } from "@/domains/agent/types";
import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import { ProjectHistoryService } from "@/domains/project/history";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import {
  agentRunEvents,
  agentRuns,
  projectChangeSetFiles,
  projectChangeSets,
  projectCheckpoints,
  projectFileBlobs,
  projectFiles,
  projectRevisionFiles,
  projectRevisions,
  transcriptMessages,
} from "@/infrastructure/db/schema";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

const profile: FrozenAgentRunProfile = {
  locale: "zh-CN",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  promptProfile: "webpilot-system-v4",
  promptDigest: "history-prompt-digest",
  toolsetProfile: "webpilot-browser-v3",
  toolsetDigest: "history-toolset-digest",
  modelProfile: "coding-agent-v1",
  repositoryCapability: {
    storageKind: "database",
    canRead: true,
    canWrite: true,
    canExecuteServerTools: true,
  },
  budget: {
    maxModelTurns: 12,
    maxWallTimeSeconds: 300,
    maxOutputCharacters: 24_000,
    maxToolResultCharacters: 20_000,
    maxFileMutations: 8,
    maxClientResumes: 6,
    maxNoProgressRepeats: 2,
  },
};

describe("ProjectHistoryService", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.testDatabase.close();
  });

  it("creates start/success checkpoints and persists a complete ChangeSet", async () => {
    const { project, run, repository, store, history, database } = fixture;

    let revision = project.revision;
    revision = (
      await repository.writeFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/update.ts",
        content: "agent update",
        expectedRevision: revision,
      })
    ).revision;
    revision = (
      await repository.writeFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/create.ts",
        content: "created",
        expectedRevision: revision,
      })
    ).revision;
    revision = (
      await repository.deleteFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/delete.ts",
        expectedRevision: revision,
      })
    ).revision;
    revision = (
      await repository.renameFile({
        ownerId: run.ownerId,
        projectId: project.id,
        fromPath: "src/old.ts",
        toPath: "src/new.ts",
        expectedRevision: revision,
      })
    ).revision;
    await store.updateRunProgress({
      ownerId: run.ownerId,
      runId: run.id,
      currentRevision: revision,
    });
    await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });
    const completedRun = await store.getRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    const changeSet = await history.getRunChangeSet({
      ownerId: run.ownerId,
      runId: run.id,
    });
    expect(completedRun.usage.activeExecutionStartedAt).toBeNull();
    expect(completedRun.usage.activeExecutionDurationMs).toBeGreaterThanOrEqual(
      0,
    );
    expect(changeSet).toMatchObject({
      runId: run.id,
      baseRevision: 1,
      resultRevision: 5,
      summary: "新增 1 个，修改 1 个，删除 1 个，重命名 1 个",
    });
    expect(
      changeSet.files.map((file) => ({
        operation: file.operation,
        pathBefore: file.pathBefore,
        pathAfter: file.pathAfter,
        beforeContent: file.beforeContent,
        afterContent: file.afterContent,
      })),
    ).toEqual([
      {
        operation: "create",
        pathBefore: null,
        pathAfter: "src/create.ts",
        beforeContent: null,
        afterContent: "created",
      },
      {
        operation: "delete",
        pathBefore: "src/delete.ts",
        pathAfter: null,
        beforeContent: "delete me",
        afterContent: null,
      },
      {
        operation: "rename",
        pathBefore: "src/old.ts",
        pathAfter: "src/new.ts",
        beforeContent: "rename me",
        afterContent: "rename me",
      },
      {
        operation: "update",
        pathBefore: "src/update.ts",
        pathAfter: "src/update.ts",
        beforeContent: "base update",
        afterContent: "agent update",
      },
    ]);

    const checkpoints = await database
      .select()
      .from(projectCheckpoints)
      .where(eq(projectCheckpoints.runId, run.id));
    expect(checkpoints.map((checkpoint) => checkpoint.kind).sort()).toEqual([
      "agent_start",
      "agent_success",
    ]);
    await expect(
      database
        .select()
        .from(projectChangeSets)
        .where(eq(projectChangeSets.runId, run.id)),
    ).resolves.toHaveLength(1);
  });

  it("does not mark the Run succeeded when the start checkpoint is missing", async () => {
    const { run, store, database } = fixture;

    // 人为删除起点 checkpoint，模拟旧数据损坏或迁移遗漏。成功状态、成功
    // checkpoint、ChangeSet 与状态事件必须在同一事务内失败，不能留下半成品。
    await database
      .delete(projectCheckpoints)
      .where(
        and(
          eq(projectCheckpoints.runId, run.id),
          eq(projectCheckpoints.kind, "agent_start"),
        ),
      );
    const eventCountBefore = await countRows(database, agentRunEvents);

    await expect(
      store.completeSuccessfulRun({
        ownerId: run.ownerId,
        runId: run.id,
      }),
    ).rejects.toMatchObject({
      code: PROJECT_ERROR_CODES.checkpointNotFound,
    });

    const [persistedRun] = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    expect(persistedRun?.status).toBe("running");
    await expect(
      database
        .select()
        .from(projectCheckpoints)
        .where(
          and(
            eq(projectCheckpoints.runId, run.id),
            eq(projectCheckpoints.kind, "agent_success"),
          ),
        ),
    ).resolves.toHaveLength(0);
    await expect(
      database
        .select()
        .from(projectChangeSets)
        .where(eq(projectChangeSets.runId, run.id)),
    ).resolves.toHaveLength(0);
    expect(await countRows(database, agentRunEvents)).toBe(eventCountBefore);
  });

  it("repairs a half-finalized Run without duplicating success history", async () => {
    const { run, repository, store, database } = fixture;
    const mutation = await repository.writeFile({
      ownerId: run.ownerId,
      projectId: run.projectId,
      path: "src/update.ts",
      content: "half-finalized content",
      expectedRevision: 1,
    });
    await store.updateRunProgress({
      ownerId: run.ownerId,
      runId: run.id,
      currentRevision: mutation.revision,
    });
    await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    const [terminalEvent] = await database
      .select({ id: agentRunEvents.id })
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.runId, run.id),
          eq(agentRunEvents.type, "run.status_changed"),
          sql`${agentRunEvents.payload}->>'status' = 'succeeded'`,
        ),
      );
    expect(terminalEvent).toBeDefined();

    // 精确模拟线上观测到的半完成状态：success checkpoint、ChangeSet 与文件
    // 清单已经存在，但 Run 和终态事件仍未完成。可重入收尾只能补齐缺项。
    await database
      .update(agentRuns)
      .set({
        status: "running",
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));
    await database
      .delete(agentRunEvents)
      .where(eq(agentRunEvents.id, terminalEvent!.id));

    const successCheckpointCountBefore = await countMatchingRows(
      database,
      projectCheckpoints,
      and(
        eq(projectCheckpoints.runId, run.id),
        eq(projectCheckpoints.kind, "agent_success"),
      ),
    );
    const changeSetCountBefore = await countMatchingRows(
      database,
      projectChangeSets,
      eq(projectChangeSets.runId, run.id),
    );
    const changeSetFileCountBefore = await countRows(
      database,
      projectChangeSetFiles,
    );

    const repaired = await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    expect(repaired.status).toBe("succeeded");
    expect(repaired.completedAt).toBeInstanceOf(Date);
    expect(
      await countMatchingRows(
        database,
        projectCheckpoints,
        and(
          eq(projectCheckpoints.runId, run.id),
          eq(projectCheckpoints.kind, "agent_success"),
        ),
      ),
    ).toBe(successCheckpointCountBefore);
    expect(
      await countMatchingRows(
        database,
        projectChangeSets,
        eq(projectChangeSets.runId, run.id),
      ),
    ).toBe(changeSetCountBefore);
    expect(await countRows(database, projectChangeSetFiles)).toBe(
      changeSetFileCountBefore,
    );
    expect(
      await countMatchingRows(
        database,
        agentRunEvents,
        and(
          eq(agentRunEvents.runId, run.id),
          eq(agentRunEvents.type, "run.status_changed"),
          sql`${agentRunEvents.payload}->>'status' = 'succeeded'`,
        ),
      ),
    ).toBe(1);
  });

  it("deduplicates blobs, keeps full manifests and soft-deletes files", async () => {
    const { project, repository, database } = fixture;
    const initialBlobCount = await countRows(database, projectFileBlobs);

    await repository.writeFile({
      ownerId: "owner-history",
      projectId: project.id,
      path: "src/copy.ts",
      content: "base update",
      expectedRevision: 1,
    });

    const blobCount = await countRows(database, projectFileBlobs);
    expect(blobCount).toBe(initialBlobCount);

    const [revision] = await database
      .select({ id: projectRevisions.id })
      .from(projectRevisions)
      .where(
        and(
          eq(projectRevisions.projectId, project.id),
          eq(projectRevisions.revision, 2),
        ),
      );
    expect(revision).toBeDefined();
    const manifest = await database
      .select()
      .from(projectRevisionFiles)
      .where(eq(projectRevisionFiles.revisionId, revision!.id));
    expect(manifest).toHaveLength(4);

    await repository.deleteFile({
      ownerId: "owner-history",
      projectId: project.id,
      path: "src/delete.ts",
      expectedRevision: 2,
    });
    const [deleted] = await database
      .select()
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.projectId, project.id),
          eq(projectFiles.path, "src/delete.ts"),
        ),
      );
    expect(deleted?.deletedAt).toBeInstanceOf(Date);
  });

  it("restores into a new revision without deleting Run, transcript or checkpoints", async () => {
    const { project, run, repository, store, history, database } = fixture;
    const mutation = await repository.writeFile({
      ownerId: run.ownerId,
      projectId: project.id,
      path: "src/update.ts",
      content: "agent update",
      expectedRevision: 1,
    });
    await store.updateRunProgress({
      ownerId: run.ownerId,
      runId: run.id,
      currentRevision: mutation.revision,
    });
    await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    const transcriptCountBefore = await countRows(database, transcriptMessages);
    const preview = await history.previewRestore({
      ownerId: run.ownerId,
      runId: run.id,
    });
    expect(preview).toMatchObject({
      currentRevision: 2,
      canRestore: true,
      conflicts: [],
    });

    const restored = await history.restoreRunChangeSet({
      ownerId: run.ownerId,
      runId: run.id,
      expectedRevision: preview.currentRevision,
    });
    expect(restored).toMatchObject({
      revision: 3,
      changedPaths: ["src/update.ts"],
      checkpoint: { kind: "restore", revision: 3 },
    });
    await expect(
      repository.readFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/update.ts",
      }),
    ).resolves.toMatchObject({ content: "base update" });

    await expect(
      database.select().from(agentRuns).where(eq(agentRuns.id, run.id)),
    ).resolves.toHaveLength(1);
    expect(await countRows(database, transcriptMessages)).toBe(
      transcriptCountBefore,
    );
    const checkpoints = await database
      .select()
      .from(projectCheckpoints)
      .where(eq(projectCheckpoints.projectId, project.id));
    expect(checkpoints.map((checkpoint) => checkpoint.kind).sort()).toEqual([
      "agent_start",
      "agent_success",
      "restore",
    ]);
  });

  it("rejects stale expectedRevision before applying restore", async () => {
    const { project, run, repository, store, history } = fixture;
    const agentMutation = await repository.writeFile({
      ownerId: run.ownerId,
      projectId: project.id,
      path: "src/update.ts",
      content: "agent update",
      expectedRevision: 1,
    });
    await store.updateRunProgress({
      ownerId: run.ownerId,
      runId: run.id,
      currentRevision: agentMutation.revision,
    });
    await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    await repository.writeFile({
      ownerId: run.ownerId,
      projectId: project.id,
      path: "src/unrelated.ts",
      content: "later",
      expectedRevision: 2,
    });

    await expect(
      history.restoreRunChangeSet({
        ownerId: run.ownerId,
        runId: run.id,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: PROJECT_ERROR_CODES.revisionConflict,
      details: { actualRevision: 3, expectedRevision: 2 },
    });
  });

  it("reports partial conflicts and leaves all files untouched", async () => {
    const { project, run, repository, store, history } = fixture;
    let revision = (
      await repository.writeFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/update.ts",
        content: "agent update",
        expectedRevision: 1,
      })
    ).revision;
    revision = (
      await repository.writeFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/create.ts",
        content: "agent create",
        expectedRevision: revision,
      })
    ).revision;
    await store.updateRunProgress({
      ownerId: run.ownerId,
      runId: run.id,
      currentRevision: revision,
    });
    await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    const laterMutation = await repository.writeFile({
      ownerId: run.ownerId,
      projectId: project.id,
      path: "src/create.ts",
      content: "user mutation",
      expectedRevision: revision,
    });
    const preview = await history.previewRestore({
      ownerId: run.ownerId,
      runId: run.id,
    });
    expect(preview.canRestore).toBe(false);
    expect(preview.conflicts).toMatchObject([
      { path: "src/create.ts", reason: "modified" },
    ]);

    await expect(
      history.restoreRunChangeSet({
        ownerId: run.ownerId,
        runId: run.id,
        expectedRevision: laterMutation.revision,
      }),
    ).rejects.toMatchObject({
      code: PROJECT_ERROR_CODES.restoreConflict,
    });
    await expect(
      repository.readFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/update.ts",
      }),
    ).resolves.toMatchObject({ content: "agent update" });
    await expect(
      repository.readFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/create.ts",
      }),
    ).resolves.toMatchObject({ content: "user mutation" });
  });

  it("returns a stable error when ChangeSet content is missing", async () => {
    const { run, repository, store, history, database, testDatabase } = fixture;
    const mutation = await repository.writeFile({
      ownerId: run.ownerId,
      projectId: run.projectId,
      path: "src/update.ts",
      content: "agent content that will be removed",
      expectedRevision: 1,
    });
    await store.updateRunProgress({
      ownerId: run.ownerId,
      runId: run.id,
      currentRevision: mutation.revision,
    });
    await store.completeSuccessfulRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    const [change] = await database
      .select({ afterHash: projectChangeSetFiles.afterHash })
      .from(projectChangeSetFiles)
      .innerJoin(
        projectChangeSets,
        eq(projectChangeSetFiles.changeSetId, projectChangeSets.id),
      )
      .where(eq(projectChangeSets.runId, run.id));
    expect(change?.afterHash).toBeTruthy();

    // 正常数据库约束会阻止删除仍被 manifest 和 ChangeSet 引用的 blob。
    // 测试临时移除这些 FK，只为模拟底层数据损坏，并验证领域层不会泄漏
    // PostgreSQL 错误或返回缺少正文的伪完整 ChangeSet。
    for (const constraint of [
      ["project_files", "project_files_blob_hash_project_file_blobs_hash_fk"],
      [
        "project_revision_files",
        "project_revision_files_blob_hash_project_file_blobs_hash_fk",
      ],
      [
        "project_change_set_files",
        "project_change_set_files_before_hash_project_file_blobs_hash_fk",
      ],
      [
        "project_change_set_files",
        "project_change_set_files_after_hash_project_file_blobs_hash_fk",
      ],
    ] as const) {
      await testDatabase.client.exec(
        `alter table "${constraint[0]}" drop constraint "${constraint[1]}"`,
      );
    }
    await database
      .delete(projectFileBlobs)
      .where(eq(projectFileBlobs.hash, change!.afterHash!));

    await expect(
      history.getRunChangeSet({
        ownerId: run.ownerId,
        runId: run.id,
      }),
    ).rejects.toMatchObject({
      code: PROJECT_ERROR_CODES.checkpointContentMissing,
      details: { missingHashes: [change!.afterHash] },
    });
  });
});

async function createFixture() {
  const testDatabase = await createTestDatabase();
  const repository = new DatabaseProjectRepository(testDatabase.database);
  const project = await repository.createProject({
    ownerId: "owner-history",
    name: "History project",
    initialFiles: [
      { path: "src/update.ts", content: "base update" },
      { path: "src/delete.ts", content: "delete me" },
      { path: "src/old.ts", content: "rename me" },
    ],
  });
  const store = new AgentStore(testDatabase.database);
  const run = await store.createRun({
    ownerId: "owner-history",
    projectId: project.id,
    conversationTitle: "历史测试",
    userMessage: "请修改项目",
    profile,
  });
  await store.transitionRun({
    ownerId: run.ownerId,
    runId: run.id,
    status: "running",
  });

  return {
    testDatabase,
    database: testDatabase.database,
    repository,
    history: new ProjectHistoryService(testDatabase.database),
    store,
    project,
    run,
  };
}

async function countRows(
  database: Awaited<ReturnType<typeof createTestDatabase>>["database"],
  table:
    | typeof projectFileBlobs
    | typeof projectRevisionFiles
    | typeof projectChangeSetFiles
    | typeof transcriptMessages
    | typeof agentRunEvents,
) {
  const [result] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(table);
  return result?.count ?? 0;
}

async function countMatchingRows(
  database: Awaited<ReturnType<typeof createTestDatabase>>["database"],
  table:
    | typeof projectCheckpoints
    | typeof projectChangeSets
    | typeof agentRunEvents,
  where: SQL<unknown> | undefined,
) {
  const [result] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(where);
  return result?.count ?? 0;
}
