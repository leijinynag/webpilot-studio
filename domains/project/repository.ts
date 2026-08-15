import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core/session";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

import {
  browserGitMigrationSessions,
  agentRunEvents,
  agentRuns,
  chatAttachments,
  imageJobs,
  imageRuns,
  quotaLeases,
  projectFileBlobs,
  projectAssets,
  projectFiles,
  projectRevisionFiles,
  projectRevisions,
  projects,
  toolInvocations,
} from "@/infrastructure/db/schema";
import { serializeMigrationManifest } from "@/domains/project/migration-manifest";
import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";
import { normalizeProjectFileMutations } from "@/domains/project/file-mutations";
import { assertValidProjectPath } from "@/domains/project/path";
import type {
  BrowserGitProvision,
  ProjectCheckpoint,
  BrowserGitMigrationPreparation,
  BrowserGitMigrationResult,
  ProjectDescription,
  ProjectFileMutation,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
  ProjectSearchOptions,
  ProjectStorageKind,
  ProjectSummary,
} from "@/domains/project/types";
import { databaseSchema } from "@/infrastructure/db/schema";
import { getPrivateBlobStore } from "@/infrastructure/blob/private-store";
import { AGENT_ERROR_CODES } from "@/domains/agent/errors";

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

export type ProjectRepository = {
  listProjects(input: {
    ownerId: string;
    includeDeleted?: boolean;
  }): Promise<ProjectSummary[]>;
  createProject(input: {
    ownerId: string;
    name: string;
    storageKind?: ProjectStorageKind;
    initialFiles: readonly { path: string; content: string }[];
  }): Promise<ProjectDescription>;
  describe(input: {
    ownerId: string;
    projectId: string;
    includeDeleted?: boolean;
  }): Promise<ProjectDescription>;
  renameProject(input: {
    ownerId: string;
    projectId: string;
    name: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  deleteProject(input: { ownerId: string; projectId: string }): Promise<void>;
  restoreProject(input: { ownerId: string; projectId: string }): Promise<void>;
  claimBrowserGitProvision(input: {
    ownerId: string;
    projectId: string;
  }): Promise<BrowserGitProvision>;
  markBrowserGitUnavailable(input: {
    ownerId: string;
    projectId: string;
  }): Promise<void>;
  prepareBrowserGitMigration(input: {
    ownerId: string;
    projectId: string;
  }): Promise<BrowserGitMigrationPreparation>;
  finalizeBrowserGitMigration(input: {
    ownerId: string;
    projectId: string;
    sessionId: string;
    token: string;
    candidateRepositoryId: string;
    manifestHash: string;
    head: string;
  }): Promise<BrowserGitMigrationResult>;
  cancelBrowserGitMigration(input: {
    ownerId: string;
    projectId: string;
    sessionId: string;
    token: string;
  }): Promise<void>;
  listFiles(input: {
    ownerId: string;
    projectId: string;
  }): Promise<ProjectFileSnapshot[]>;
  readFile(input: {
    ownerId: string;
    projectId: string;
    path: string;
  }): Promise<ProjectFileSnapshot>;
  searchText(input: {
    ownerId: string;
    projectId: string;
    query: string;
    options?: ProjectSearchOptions;
  }): Promise<ProjectSearchMatch[]>;
  writeFile(input: {
    ownerId: string;
    projectId: string;
    path: string;
    content: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  deleteFile(input: {
    ownerId: string;
    projectId: string;
    path: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  renameFile(input: {
    ownerId: string;
    projectId: string;
    fromPath: string;
    toPath: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  batchMutateFiles(input: {
    ownerId: string;
    projectId: string;
    expectedRevision: number;
    mutations: readonly ProjectFileMutation[];
  }): Promise<ProjectMutationResult>;
  createCheckpoint(input: {
    ownerId: string;
    projectId: string;
    summary?: string;
    expectedRevision?: number;
  }): Promise<ProjectCheckpoint>;
  restoreCheckpoint(input: {
    ownerId: string;
    projectId: string;
    checkpointId: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
};

const DEFAULT_SEARCH_OPTIONS: Required<ProjectSearchOptions> = {
  maxResults: 100,
  maxExcerptCharacters: 240,
  maxTotalCharacters: 20_000,
};
const BROWSER_GIT_MIGRATION_TTL_MS = 15 * 60 * 1000;

export class DatabaseProjectRepository<
  TQueryResult extends PgQueryResultHKT,
> implements ProjectRepository {
  constructor(private readonly db: DatabaseLike<TQueryResult>) {}

  async listProjects(input: {
    ownerId: string;
    includeDeleted?: boolean;
  }): Promise<ProjectSummary[]> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.ownerId, input.ownerId),
          input.includeDeleted ? undefined : isNull(projects.deletedAt),
        ),
      )
      .orderBy(desc(projects.updatedAt));

    return rows.map(toProjectSummary);
  }

  async createProject(input: {
    ownerId: string;
    name: string;
    storageKind?: ProjectStorageKind;
    initialFiles: readonly { path: string; content: string }[];
  }): Promise<ProjectDescription> {
    const name = normalizeProjectName(input.name);
    const storageKind = input.storageKind ?? "database";
    // 空 Repository 从 revision 0 起步；显式模板仍以 revision 1 表示首次
    // 文件快照。两种项目都创建 revision 行，Agent checkpoint 因而可以统一
    // 引用完整历史事实，不需要为“尚无文件”增加旁路逻辑。
    const initialRevision = input.initialFiles.length === 0 ? 0 : 1;

    for (const file of input.initialFiles) {
      assertValidProjectPath(file.path);
    }

    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({
          ownerId: input.ownerId,
          name,
          storageKind,
          // Browser Git 的源码要等客户端成功领取一次性 provision claim 后
          // 才能创建；Database 项目则在事务提交时已经具备完整源码事实。
          status: storageKind === "browser_git" ? "creating" : "ready",
          revision: initialRevision,
        })
        .returning();

      if (!project) {
        throw new Error("创建项目失败。");
      }

      const revisionId = await insertRevision(tx, {
        projectId: project.id,
        revision: initialRevision,
        kind: "initial",
        summary:
          initialRevision === 0
            ? "Initialize empty project"
            : "Initialize project template",
      });

      for (const file of input.initialFiles) {
        const blobHash = await ensureBlob(tx, file.content);
        await tx.insert(projectFiles).values({
          projectId: project.id,
          path: file.path,
          blobHash,
          updatedAt: project.updatedAt,
        });
        await tx.insert(projectRevisionFiles).values({
          revisionId,
          path: file.path,
          blobHash,
        });
      }

      return {
        ...toProjectSummary(project),
        fileCount: input.initialFiles.length,
      };
    });
  }

  async describe(input: {
    ownerId: string;
    projectId: string;
    includeDeleted?: boolean;
  }): Promise<ProjectDescription> {
    const project = await this.getProject(input);
    const [count] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.projectId, project.id),
          isNull(projectFiles.deletedAt),
        ),
      );

    return {
      ...toProjectSummary(project),
      fileCount: count?.count ?? 0,
    };
  }

  async renameProject(input: {
    ownerId: string;
    projectId: string;
    name: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    const name = normalizeProjectName(input.name);

    return this.mutateProject({
      ownerId: input.ownerId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      kind: "rename",
      changedPaths: [],
      operation: async (tx, project) => {
        await tx
          .update(projects)
          .set({ name, updatedAt: new Date() })
          .where(eq(projects.id, project.id));
      },
    });
  }

  async deleteProject(input: {
    ownerId: string;
    projectId: string;
  }): Promise<void> {
    const pathnames = await this.db.transaction(async (tx) => {
      // 项目行是上传、文件 mutation 和异步 Worker 共同使用的并发闸门。
      // 删除先锁住它，确保本事务看到的是一份稳定的资产引用快照。
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .for("update");

      if (!project) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.projectDeleted,
          "项目不存在、已删除或不属于当前匿名工作区。",
          404,
        );
      }

      const activeAttachments = await tx
        .select({ pathname: chatAttachments.blobPathname })
        .from(chatAttachments)
        .where(
          and(
            eq(chatAttachments.projectId, project.id),
            eq(chatAttachments.ownerId, input.ownerId),
            isNull(chatAttachments.deletedAt),
          ),
        );
      const activeAssets = await tx
        .select({ pathname: projectAssets.blobPathname })
        .from(projectAssets)
        .where(
          and(
            eq(projectAssets.projectId, project.id),
            eq(projectAssets.ownerId, input.ownerId),
            isNull(projectAssets.deletedAt),
          ),
        );

      const activeImageRuns = await tx
        .select({ id: imageRuns.id })
        .from(imageRuns)
        .where(
          and(
            eq(imageRuns.projectId, project.id),
            eq(imageRuns.ownerId, input.ownerId),
            inArray(imageRuns.status, ["queued", "running"]),
          ),
        );

      const now = new Date();
      await tx
        .update(chatAttachments)
        .set({ status: "deleted", deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(chatAttachments.projectId, project.id),
            eq(chatAttachments.ownerId, input.ownerId),
            isNull(chatAttachments.deletedAt),
          ),
        );
      await tx
        .update(projectAssets)
        .set({ deletedAt: now })
        .where(
          and(
            eq(projectAssets.projectId, project.id),
            eq(projectAssets.ownerId, input.ownerId),
            isNull(projectAssets.deletedAt),
          ),
        );

      // 删除项目时，队列中的任务不再有业务意义。取消状态会让已经失去
      // lease 的旧 Worker 无法再次提交成功结果，也便于后台清理任务统计。
      await tx
        .update(imageJobs)
        .set({
          status: "cancelled",
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(imageJobs.projectId, project.id),
            eq(imageJobs.ownerId, input.ownerId),
            inArray(imageJobs.status, ["queued", "running", "retryable"]),
          ),
        );
      await tx
        .update(imageRuns)
        .set({
          status: "cancelled",
          errorCode: AGENT_ERROR_CODES.cancelled,
          errorMessage: "项目已删除，图片生成任务已取消。",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(imageRuns.projectId, project.id),
            eq(imageRuns.ownerId, input.ownerId),
            inArray(imageRuns.status, ["queued", "running"]),
          ),
        );

      const activeRuns = await tx
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.projectId, project.id),
            eq(agentRuns.ownerId, input.ownerId),
            inArray(agentRuns.status, [
              "queued",
              "running",
              "awaiting_client_tool",
              "awaiting_async_job",
            ]),
          ),
        );
      if (activeRuns.length > 0) {
        const runIds = activeRuns.map((run) => run.id);
        await tx
          .update(toolInvocations)
          .set({
            status: "cancelled",
            errorCode: AGENT_ERROR_CODES.cancelled,
            completedAt: now,
          })
          .where(
            and(
              inArray(toolInvocations.runId, runIds),
              eq(toolInvocations.status, "running"),
            ),
          );
        await tx
          .update(agentRuns)
          .set({
            status: "cancelled",
            cancellationRequestedAt: now,
            errorCode: AGENT_ERROR_CODES.cancelled,
            errorMessage: "项目已删除，Agent Run 已取消。",
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              inArray(agentRuns.id, runIds),
              inArray(agentRuns.status, [
                "queued",
                "running",
                "awaiting_client_tool",
                "awaiting_async_job",
              ]),
            ),
          );
        await tx.insert(agentRunEvents).values(
          activeRuns.map((run) => ({
            runId: run.id,
            type: "run.status_changed",
            payload: {
              previousStatus: run.status,
              status: "cancelled",
              reason: "project_deleted",
            },
          })),
        );
      }

      // 项目删除不经过 Agent runtime，因此需要在同一数据库事务里释放
      // 已绑定的 Agent/Image quota lease。更新条件同时包含 resource，
      // 避免同一 UUID 在不同事实表之间发生误匹配。
      const activeAgentRunIds = activeRuns.map((run) => run.id);
      const activeImageRunIds = activeImageRuns.map((run) => run.id);
      if (activeAgentRunIds.length > 0) {
        await tx
          .update(quotaLeases)
          .set({
            status: "released",
            releasedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(quotaLeases.status, "active"),
              eq(quotaLeases.ownerId, input.ownerId),
              eq(quotaLeases.resource, "agent_run"),
              sql`${quotaLeases.metadata}->>'resourceId' in (${sql.join(
                activeAgentRunIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          );
      }
      if (activeImageRunIds.length > 0) {
        await tx
          .update(quotaLeases)
          .set({
            status: "released",
            releasedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(quotaLeases.status, "active"),
              eq(quotaLeases.ownerId, input.ownerId),
              eq(quotaLeases.resource, "image_generation"),
              sql`${quotaLeases.metadata}->>'resourceId' in (${sql.join(
                activeImageRunIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          );
      }

      await tx
        .update(projects)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        );

      return [
        ...activeAttachments.map((row) => row.pathname),
        ...activeAssets.map((row) => row.pathname),
      ];
    });

    // Blob 不参与数据库事务。提交成功后再按当前引用检查删除，清理失败只记日志，
    // 让“项目已删除”这个用户可见事实不被存储服务故障阻断。
    await Promise.all(
      [...new Set(pathnames)].map((pathname) =>
        this.deleteProjectBlobIfUnreferenced(pathname),
      ),
    );
  }

  async restoreProject(input: {
    ownerId: string;
    projectId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, input.ownerId),
          ),
        )
        .for("update");

      if (!project) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.projectNotFound,
          "项目不存在或不属于当前匿名工作区。",
          404,
        );
      }

      if (!project.deletedAt) {
        return;
      }

      // 资产和附件的 deletedAt/status 不在恢复流程中回滚，避免重新暴露
      // 已被用户删除或已经被清理的私有对象。
      await tx
        .update(projects)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.ownerId, input.ownerId),
            sql`${projects.deletedAt} is not null`,
          ),
        );
    });
  }

  async claimBrowserGitProvision(input: {
    ownerId: string;
    projectId: string;
  }): Promise<BrowserGitProvision> {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        );

      if (!project) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.projectDeleted,
          "项目不存在、已删除或不属于当前匿名工作区。",
          404,
        );
      }
      this.assertBrowserGitProject(project);

      if (project.status !== "creating") {
        return {
          allowCreate: false,
          status: project.status,
          initialFiles: [],
        };
      }

      // status 条件让 claim 具备一次性消费语义。即使两个页面同时挂载，
      // 也只有一个请求能把 creating 原子推进到 ready 并获得创建权。
      const [claimed] = await tx
        .update(projects)
        .set({ status: "ready", updatedAt: new Date() })
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.ownerId, input.ownerId),
            eq(projects.storageKind, "browser_git"),
            eq(projects.status, "creating"),
            isNull(projects.deletedAt),
          ),
        )
        .returning({ status: projects.status });

      if (!claimed) {
        return {
          allowCreate: false,
          status: "ready",
          initialFiles: [],
        };
      }

      // Browser Git 创建前，模板暂存在服务端 revision 快照中。只有真正获得
      // 创建权的页面能读取该快照，并把它一次性写入当前浏览器的 IndexedDB。
      const initialFiles = await tx
        .select({
          path: projectFiles.path,
          content: projectFileBlobs.content,
        })
        .from(projectFiles)
        .innerJoin(
          projectFileBlobs,
          eq(projectFiles.blobHash, projectFileBlobs.hash),
        )
        .where(
          and(
            eq(projectFiles.projectId, project.id),
            isNull(projectFiles.deletedAt),
          ),
        )
        .orderBy(asc(projectFiles.path));

      return {
        allowCreate: true,
        status: claimed.status,
        initialFiles,
      };
    });
  }

  async markBrowserGitUnavailable(input: {
    ownerId: string;
    projectId: string;
  }): Promise<void> {
    const project = await this.getProject(input);
    this.assertBrowserGitProject(project);

    await this.db
      .update(projects)
      .set({ status: "unavailable", updatedAt: new Date() })
      .where(
        and(
          eq(projects.id, project.id),
          eq(projects.ownerId, input.ownerId),
          eq(projects.storageKind, "browser_git"),
          isNull(projects.deletedAt),
        ),
      );
  }

  async prepareBrowserGitMigration(input: {
    ownerId: string;
    projectId: string;
  }): Promise<BrowserGitMigrationPreparation> {
    return this.db.transaction(async (tx) => {
      // 锁住项目索引，确保随后导出的文件和 sourceRevision 属于同一份事实。
      // 普通文件 mutation 也必须更新 projects 行，因此会等待本事务结束。
      await tx.execute(
        sql`select ${projects.id} from ${projects}
            where ${projects.id} = ${input.projectId}
              and ${projects.ownerId} = ${input.ownerId}
              and ${projects.deletedAt} is null
            for update`,
      );
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        );

      if (!project) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.projectDeleted,
          "项目不存在、已删除或不属于当前匿名工作区。",
          404,
        );
      }
      this.assertDatabaseProject(project);

      const rows = await tx
        .select({
          path: projectFiles.path,
          content: projectFileBlobs.content,
          hash: projectFileBlobs.hash,
        })
        .from(projectFiles)
        .innerJoin(
          projectFileBlobs,
          eq(projectFiles.blobHash, projectFileBlobs.hash),
        )
        .where(
          and(
            eq(projectFiles.projectId, project.id),
            isNull(projectFiles.deletedAt),
          ),
        )
        .orderBy(asc(projectFiles.path));
      const manifestHash = hashMigrationManifest(rows);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + BROWSER_GIT_MIGRATION_TTL_MS);
      const [session] = await tx
        .insert(browserGitMigrationSessions)
        .values({
          projectId: project.id,
          ownerId: input.ownerId,
          tokenHash: hashContent(token),
          sourceRevision: project.revision,
          candidateRepositoryId: `migration-${randomUUID()}`,
          manifestHash,
          expiresAt,
        })
        .returning();

      if (!session) {
        throw new Error("创建 Browser Git 迁移会话失败。");
      }

      return {
        sessionId: session.id,
        token,
        projectId: project.id,
        projectName: project.name,
        sourceRevision: project.revision,
        candidateRepositoryId: session.candidateRepositoryId,
        manifestHash,
        files: rows,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async finalizeBrowserGitMigration(input: {
    ownerId: string;
    projectId: string;
    sessionId: string;
    token: string;
    candidateRepositoryId: string;
    manifestHash: string;
    head: string;
  }): Promise<BrowserGitMigrationResult> {
    return this.db.transaction(async (tx) => {
      // session 与 project 同时加锁，保证幂等 finalize 和 storageKind 切换
      // 在并发请求下仍只有一个确定结果。
      await tx.execute(
        sql`select ${browserGitMigrationSessions.id}
            from ${browserGitMigrationSessions}
            where ${browserGitMigrationSessions.id} = ${input.sessionId}
            for update`,
      );
      await tx.execute(
        sql`select ${projects.id} from ${projects}
            where ${projects.id} = ${input.projectId}
            for update`,
      );
      const [session] = await tx
        .select()
        .from(browserGitMigrationSessions)
        .where(
          and(
            eq(browserGitMigrationSessions.id, input.sessionId),
            eq(browserGitMigrationSessions.projectId, input.projectId),
            eq(browserGitMigrationSessions.ownerId, input.ownerId),
          ),
        );
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        );

      if (!session || !project) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.projectNotFound,
          "迁移会话不存在或不属于当前项目。",
          404,
        );
      }

      assertMigrationProof(session, input);

      if (session.status === "completed") {
        if (project.storageKind !== "browser_git") {
          throw new ProjectError(
            PROJECT_ERROR_CODES.migrationConflict,
            "迁移会话已完成，但项目存储状态不一致。",
            409,
          );
        }
        return {
          project: await describeProjectInTransaction(tx, project),
          alreadyCompleted: true,
        };
      }

      if (session.status === "cancelled") {
        throw new ProjectError(
          PROJECT_ERROR_CODES.migrationConflict,
          "迁移会话已经取消，请重新发起迁移。",
          409,
        );
      }
      if (session.expiresAt.getTime() <= Date.now()) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.migrationExpired,
          "迁移会话已过期，请重新发起迁移。",
          409,
        );
      }
      this.assertDatabaseProject(project);

      if (project.revision !== session.sourceRevision) {
        throwRevisionConflict(project.revision, session.sourceRevision);
      }

      const now = new Date();
      const [updatedProject] = await tx
        .update(projects)
        .set({
          storageKind: "browser_git",
          status: "ready",
          updatedAt: now,
        })
        .where(
          and(
            eq(projects.id, project.id),
            eq(projects.ownerId, input.ownerId),
            eq(projects.storageKind, "database"),
            eq(projects.revision, session.sourceRevision),
            isNull(projects.deletedAt),
          ),
        )
        .returning();

      if (!updatedProject) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.migrationConflict,
          "项目在迁移切换前发生变化，Database Repository 保持可用。",
          409,
        );
      }

      await tx
        .update(browserGitMigrationSessions)
        .set({
          status: "completed",
          expectedHead: input.head,
          completedAt: now,
        })
        .where(eq(browserGitMigrationSessions.id, session.id));

      return {
        project: await describeProjectInTransaction(tx, updatedProject),
        alreadyCompleted: false,
      };
    });
  }

  async cancelBrowserGitMigration(input: {
    ownerId: string;
    projectId: string;
    sessionId: string;
    token: string;
  }): Promise<void> {
    const [session] = await this.db
      .select()
      .from(browserGitMigrationSessions)
      .where(
        and(
          eq(browserGitMigrationSessions.id, input.sessionId),
          eq(browserGitMigrationSessions.projectId, input.projectId),
          eq(browserGitMigrationSessions.ownerId, input.ownerId),
        ),
      );

    if (!session || session.tokenHash !== hashContent(input.token)) {
      throw new ProjectError(
        PROJECT_ERROR_CODES.projectNotFound,
        "迁移会话不存在或不属于当前项目。",
        404,
      );
    }
    if (session.status !== "prepared") {
      return;
    }

    await this.db
      .update(browserGitMigrationSessions)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(
        and(
          eq(browserGitMigrationSessions.id, session.id),
          eq(browserGitMigrationSessions.status, "prepared"),
        ),
      );
  }

  async listFiles(input: {
    ownerId: string;
    projectId: string;
  }): Promise<ProjectFileSnapshot[]> {
    const project = await this.getProject(input);
    this.assertDatabaseProject(project);
    const rows = await this.db
      .select({
        path: projectFiles.path,
        content: projectFileBlobs.content,
        byteLength: projectFileBlobs.byteLength,
        hash: projectFileBlobs.hash,
        updatedAt: projectFiles.updatedAt,
      })
      .from(projectFiles)
      .innerJoin(
        projectFileBlobs,
        eq(projectFiles.blobHash, projectFileBlobs.hash),
      )
      .where(
        and(
          eq(projectFiles.projectId, project.id),
          isNull(projectFiles.deletedAt),
        ),
      )
      .orderBy(asc(projectFiles.path));

    return rows.map(toFileSnapshot);
  }

  async readFile(input: {
    ownerId: string;
    projectId: string;
    path: string;
  }): Promise<ProjectFileSnapshot> {
    const path = assertValidProjectPath(input.path);
    const project = await this.getProject(input);
    this.assertDatabaseProject(project);
    const [row] = await this.db
      .select({
        path: projectFiles.path,
        content: projectFileBlobs.content,
        byteLength: projectFileBlobs.byteLength,
        hash: projectFileBlobs.hash,
        updatedAt: projectFiles.updatedAt,
      })
      .from(projectFiles)
      .innerJoin(
        projectFileBlobs,
        eq(projectFiles.blobHash, projectFileBlobs.hash),
      )
      .where(
        and(
          eq(projectFiles.projectId, project.id),
          eq(projectFiles.path, path),
          isNull(projectFiles.deletedAt),
        ),
      );

    if (!row) {
      throw new ProjectError(
        PROJECT_ERROR_CODES.fileNotFound,
        "项目文件不存在。",
        404,
        { path },
      );
    }

    return toFileSnapshot(row);
  }

  async searchText(input: {
    ownerId: string;
    projectId: string;
    query: string;
    options?: ProjectSearchOptions;
  }): Promise<ProjectSearchMatch[]> {
    const query = input.query.trim();

    if (!query) {
      return [];
    }

    const project = await this.getProject(input);
    this.assertDatabaseProject(project);
    const options = { ...DEFAULT_SEARCH_OPTIONS, ...input.options };
    const rows = await this.db
      .select({
        path: projectFiles.path,
        content: projectFileBlobs.content,
      })
      .from(projectFiles)
      .innerJoin(
        projectFileBlobs,
        eq(projectFiles.blobHash, projectFileBlobs.hash),
      )
      .where(
        and(
          eq(projectFiles.projectId, project.id),
          isNull(projectFiles.deletedAt),
        ),
      )
      .orderBy(asc(projectFiles.path));

    const matches: ProjectSearchMatch[] = [];
    let totalCharacters = 0;

    for (const row of rows) {
      const lines = row.content.split(/\r?\n/);

      for (const [index, line] of lines.entries()) {
        const column = line.indexOf(query);

        if (column < 0) {
          continue;
        }

        const excerpt = truncateSearchExcerpt(
          line,
          options.maxExcerptCharacters,
        );

        if (
          matches.length >= options.maxResults ||
          totalCharacters + excerpt.length > options.maxTotalCharacters
        ) {
          return matches;
        }

        matches.push({
          path: row.path,
          line: index + 1,
          column: column + 1,
          excerpt,
        });
        totalCharacters += excerpt.length;
      }
    }

    return matches;
  }

  async writeFile(input: {
    ownerId: string;
    projectId: string;
    path: string;
    content: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    const path = assertValidProjectPath(input.path);

    return this.mutateProject({
      ownerId: input.ownerId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      kind: "write",
      changedPaths: [path],
      operation: async (tx, project) => {
        const blobHash = await ensureBlob(tx, input.content);
        const now = new Date();
        const [existing] = await tx
          .select({ id: projectFiles.id })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.projectId, project.id),
              eq(projectFiles.path, path),
            ),
          );

        if (existing) {
          await tx
            .update(projectFiles)
            .set({ blobHash, updatedAt: now, deletedAt: null })
            .where(eq(projectFiles.id, existing.id));
        } else {
          await tx.insert(projectFiles).values({
            projectId: project.id,
            path,
            blobHash,
            updatedAt: now,
          });
        }
      },
    });
  }

  async deleteFile(input: {
    ownerId: string;
    projectId: string;
    path: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    const path = assertValidProjectPath(input.path);

    return this.mutateProject({
      ownerId: input.ownerId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      kind: "delete",
      changedPaths: [path],
      operation: async (tx, project) => {
        const [file] = await tx
          .select({ id: projectFiles.id })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.projectId, project.id),
              eq(projectFiles.path, path),
              isNull(projectFiles.deletedAt),
            ),
          );

        if (!file) {
          throw new ProjectError(
            PROJECT_ERROR_CODES.fileNotFound,
            "项目文件不存在。",
            404,
            { path },
          );
        }

        await tx
          .update(projectFiles)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(projectFiles.id, file.id));
      },
    });
  }

  async renameFile(input: {
    ownerId: string;
    projectId: string;
    fromPath: string;
    toPath: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    const fromPath = assertValidProjectPath(input.fromPath);
    const toPath = assertValidProjectPath(input.toPath);

    if (fromPath === toPath) {
      throw new ProjectError(
        PROJECT_ERROR_CODES.pathConflict,
        "文件的新旧路径不能相同。",
        409,
      );
    }

    return this.mutateProject({
      ownerId: input.ownerId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      kind: "rename",
      changedPaths: [fromPath, toPath],
      operation: async (tx, project) => {
        const [source] = await tx
          .select({ id: projectFiles.id })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.projectId, project.id),
              eq(projectFiles.path, fromPath),
              isNull(projectFiles.deletedAt),
            ),
          );
        const [target] = await tx
          .select({ id: projectFiles.id })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.projectId, project.id),
              eq(projectFiles.path, toPath),
              isNull(projectFiles.deletedAt),
            ),
          );

        if (!source) {
          throw new ProjectError(
            PROJECT_ERROR_CODES.fileNotFound,
            "待重命名的项目文件不存在。",
            404,
            { path: fromPath },
          );
        }

        if (target) {
          throw new ProjectError(
            PROJECT_ERROR_CODES.pathConflict,
            "目标路径已经存在项目文件。",
            409,
            { path: toPath },
          );
        }

        await tx
          .update(projectFiles)
          .set({ path: toPath, updatedAt: new Date() })
          .where(eq(projectFiles.id, source.id));
      },
    });
  }

  async batchMutateFiles(input: {
    ownerId: string;
    projectId: string;
    expectedRevision: number;
    mutations: readonly ProjectFileMutation[];
  }): Promise<ProjectMutationResult> {
    const mutations = normalizeProjectFileMutations(input.mutations);
    const changedPaths = mutations.map((mutation) => mutation.path);

    return this.mutateProject({
      ownerId: input.ownerId,
      projectId: input.projectId,
      expectedRevision: input.expectedRevision,
      // 批量导入是一次源码快照更新，revision 历史沿用 write 类型，
      // 不为终端导入制造只被单一调用方理解的特殊 revision kind。
      kind: "write",
      changedPaths,
      operation: async (tx, project) => {
        const rows = await tx
          .select({
            id: projectFiles.id,
            path: projectFiles.path,
            deletedAt: projectFiles.deletedAt,
          })
          .from(projectFiles)
          .where(
            and(
              eq(projectFiles.projectId, project.id),
              inArray(projectFiles.path, changedPaths),
            ),
          );
        const existingByPath = new Map(rows.map((row) => [row.path, row]));

        // 必须在第一次写入前检查全部 delete。这样即使删除目标缺失，
        // 事务也不会短暂产生部分写入，更不会创建新的 revision 快照。
        for (const mutation of mutations) {
          if (
            mutation.type === "delete" &&
            (!existingByPath.get(mutation.path) ||
              existingByPath.get(mutation.path)?.deletedAt)
          ) {
            throw new ProjectError(
              PROJECT_ERROR_CODES.fileNotFound,
              "项目文件不存在。",
              404,
              { path: mutation.path },
            );
          }
        }

        const now = new Date();
        for (const mutation of mutations) {
          const existing = existingByPath.get(mutation.path);

          if (mutation.type === "delete") {
            await tx
              .update(projectFiles)
              .set({ deletedAt: now, updatedAt: now })
              .where(eq(projectFiles.id, existing!.id));
            continue;
          }

          const blobHash = await ensureBlob(tx, mutation.content);
          if (existing) {
            await tx
              .update(projectFiles)
              .set({ blobHash, updatedAt: now, deletedAt: null })
              .where(eq(projectFiles.id, existing.id));
          } else {
            await tx.insert(projectFiles).values({
              projectId: project.id,
              path: mutation.path,
              blobHash,
              updatedAt: now,
            });
          }
        }
      },
    });
  }

  async createCheckpoint(input: {
    ownerId: string;
    projectId: string;
    summary?: string;
    expectedRevision?: number;
  }): Promise<ProjectCheckpoint> {
    const project = await this.getProject(input);
    this.assertDatabaseProject(project);

    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== project.revision
    ) {
      throwRevisionConflict(project.revision, input.expectedRevision);
    }

    // 当前 schema 把每个 revision 设计成唯一事实记录。checkpoint 复用当前
    // revision 的完整快照，避免为了打标签额外制造同 revision 的冲突记录。
    const [checkpoint] = await this.db
      .select({
        id: projectRevisions.id,
        revision: projectRevisions.revision,
        summary: projectRevisions.summary,
        createdAt: projectRevisions.createdAt,
      })
      .from(projectRevisions)
      .where(
        and(
          eq(projectRevisions.projectId, project.id),
          eq(projectRevisions.revision, project.revision),
        ),
      );

    if (!checkpoint) {
      throw new Error("当前项目缺少可用的 revision 快照。");
    }

    return {
      id: checkpoint.id,
      projectId: project.id,
      runId: null,
      kind: "revision",
      revision: checkpoint.revision,
      summary: input.summary?.trim() || checkpoint.summary,
      createdAt: checkpoint.createdAt.toISOString(),
    };
  }

  async restoreCheckpoint(input: {
    ownerId: string;
    projectId: string;
    checkpointId: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    const project = await this.getProject(input);
    this.assertDatabaseProject(project);

    return this.db.transaction(async (tx) => {
      await assertRevision(tx, project, input.expectedRevision);

      const checkpointFiles = await tx
        .select({
          path: projectRevisionFiles.path,
          blobHash: projectRevisionFiles.blobHash,
        })
        .from(projectRevisionFiles)
        .innerJoin(
          projectRevisions,
          eq(projectRevisionFiles.revisionId, projectRevisions.id),
        )
        .where(
          and(
            eq(projectRevisions.id, input.checkpointId),
            eq(projectRevisions.projectId, project.id),
          ),
        );

      if (checkpointFiles.length === 0) {
        throw new ProjectError(
          PROJECT_ERROR_CODES.projectNotFound,
          "Checkpoint 不存在或不属于当前项目。",
          404,
        );
      }

      await tx
        .update(projectFiles)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(projectFiles.projectId, project.id),
            isNull(projectFiles.deletedAt),
          ),
        );

      const now = new Date();
      for (const file of checkpointFiles) {
        await tx
          .insert(projectFiles)
          .values({
            projectId: project.id,
            path: file.path,
            blobHash: file.blobHash,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [projectFiles.projectId, projectFiles.path],
            set: {
              blobHash: file.blobHash,
              deletedAt: null,
              updatedAt: now,
            },
          });
      }

      const mutation = await finishMutation(tx, project, {
        expectedRevision: input.expectedRevision,
        kind: "restore",
        changedPaths: checkpointFiles.map((file) => file.path),
      });

      return mutation;
    });
  }

  private async getProject(input: {
    ownerId: string;
    projectId: string;
    includeDeleted?: boolean;
  }) {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, input.projectId),
          eq(projects.ownerId, input.ownerId),
          input.includeDeleted ? undefined : isNull(projects.deletedAt),
        ),
      );

    if (!project) {
      throw new ProjectError(
        input.includeDeleted
          ? PROJECT_ERROR_CODES.projectNotFound
          : PROJECT_ERROR_CODES.projectDeleted,
        "项目不存在、已删除或不属于当前匿名工作区。",
        404,
      );
    }

    return project;
  }

  private async deleteProjectBlobIfUnreferenced(
    pathname: string,
  ): Promise<void> {
    const [activeAttachment] = await this.db
      .select({ id: chatAttachments.id })
      .from(chatAttachments)
      .where(
        and(
          eq(chatAttachments.blobPathname, pathname),
          isNull(chatAttachments.deletedAt),
        ),
      )
      .limit(1);
    const [activeAsset] = await this.db
      .select({ id: projectAssets.id })
      .from(projectAssets)
      .where(
        and(
          eq(projectAssets.blobPathname, pathname),
          isNull(projectAssets.deletedAt),
        ),
      )
      .limit(1);

    if (activeAttachment || activeAsset) {
      return;
    }

    try {
      await getPrivateBlobStore().del(pathname);
    } catch (error) {
      // 数据库事实已经提交，Blob 清理失败交给后续定时任务重试。
      console.error("[project-delete-blob-cleanup]", { pathname, error });
    }
  }

  private assertBrowserGitProject(project: typeof projects.$inferSelect) {
    if (project.storageKind !== "browser_git") {
      throw new ProjectError(
        PROJECT_ERROR_CODES.storageUnavailable,
        "当前项目不是 Browser Git 项目。",
        409,
      );
    }
  }

  private assertDatabaseProject(project: typeof projects.$inferSelect) {
    if (project.storageKind !== "database") {
      throw new ProjectError(
        PROJECT_ERROR_CODES.storageUnavailable,
        "Browser Git 项目的源码只能在当前浏览器中读取。",
        409,
      );
    }
  }

  private async mutateProject(input: {
    ownerId: string;
    projectId: string;
    expectedRevision: number;
    kind: "write" | "delete" | "rename";
    changedPaths: string[];
    operation: (
      tx: TransactionLike<TQueryResult>,
      project: Awaited<
        ReturnType<DatabaseProjectRepository<TQueryResult>["getProject"]>
      >,
    ) => Promise<void>;
  }): Promise<ProjectMutationResult> {
    const project = await this.getProject(input);
    this.assertDatabaseProject(project);

    return this.db.transaction(async (tx) => {
      await assertRevision(tx, project, input.expectedRevision);
      await input.operation(tx, project);

      return finishMutation(tx, project, {
        expectedRevision: input.expectedRevision,
        kind: input.kind,
        changedPaths: input.changedPaths,
      });
    });
  }
}

function normalizeProjectName(name: string): string {
  const normalized = name.trim();

  if (normalized.length < 1 || normalized.length > 120) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.invalidRequest,
      "项目名称长度必须在 1 到 120 个字符之间。",
      400,
    );
  }

  return normalized;
}

function toProjectSummary(
  project: typeof projects.$inferSelect,
): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    storageKind: project.storageKind,
    status: project.status,
    revision: project.revision,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    deletedAt: project.deletedAt?.toISOString() ?? null,
  };
}

function toFileSnapshot(row: {
  path: string;
  content: string;
  byteLength: number;
  hash: string;
  updatedAt: Date;
}): ProjectFileSnapshot {
  return {
    path: row.path,
    content: row.content,
    byteLength: row.byteLength,
    hash: row.hash,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function truncateSearchExcerpt(line: string, maxCharacters: number): string {
  if (line.length <= maxCharacters) {
    return line;
  }

  return `${line.slice(0, Math.max(0, maxCharacters - 1))}…`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function hashMigrationManifest(
  files: readonly { path: string; hash: string }[],
) {
  return createHash("sha256")
    .update(serializeMigrationManifest(files), "utf8")
    .digest("hex");
}

function assertMigrationProof(
  session: typeof browserGitMigrationSessions.$inferSelect,
  input: {
    token: string;
    candidateRepositoryId: string;
    manifestHash: string;
    head: string;
  },
) {
  const valid =
    session.tokenHash === hashContent(input.token) &&
    session.candidateRepositoryId === input.candidateRepositoryId &&
    session.manifestHash === input.manifestHash &&
    input.head.trim().length > 0 &&
    (session.expectedHead === null || session.expectedHead === input.head);

  if (!valid) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.migrationConflict,
      "Browser Git candidate 校验信息不匹配，未切换项目存储。",
      409,
    );
  }
}

async function describeProjectInTransaction(
  tx: TransactionLike<PgQueryResultHKT>,
  project: typeof projects.$inferSelect,
): Promise<ProjectDescription> {
  const [count] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, project.id),
        isNull(projectFiles.deletedAt),
      ),
    );

  return {
    ...toProjectSummary(project),
    fileCount: count?.count ?? 0,
  };
}

async function ensureBlob(
  tx: TransactionLike<PgQueryResultHKT>,
  content: string,
): Promise<string> {
  const hash = hashContent(content);

  await tx
    .insert(projectFileBlobs)
    .values({
      hash,
      content,
      byteLength: Buffer.byteLength(content, "utf8"),
    })
    .onConflictDoNothing();

  return hash;
}

async function insertRevision(
  tx: TransactionLike<PgQueryResultHKT>,
  input: {
    projectId: string;
    revision: number;
    kind: "initial" | "write" | "delete" | "rename" | "checkpoint" | "restore";
    summary?: string;
  },
): Promise<string> {
  const [revision] = await tx
    .insert(projectRevisions)
    .values({
      projectId: input.projectId,
      revision: input.revision,
      kind: input.kind,
      summary: input.summary ?? null,
    })
    .returning({ id: projectRevisions.id });

  if (!revision) {
    throw new Error("创建项目 revision 失败。");
  }

  return revision.id;
}

async function assertRevision(
  tx: TransactionLike<PgQueryResultHKT>,
  project: typeof projects.$inferSelect,
  expectedRevision: number,
): Promise<void> {
  const [updated] = await tx
    .update(projects)
    .set({
      revision: sql`${projects.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projects.id, project.id),
        eq(projects.ownerId, project.ownerId),
        isNull(projects.deletedAt),
        eq(projects.revision, expectedRevision),
      ),
    )
    .returning({ revision: projects.revision });

  if (!updated) {
    const [current] = await tx
      .select({ revision: projects.revision })
      .from(projects)
      .where(
        and(eq(projects.id, project.id), eq(projects.ownerId, project.ownerId)),
      );

    throwRevisionConflict(
      current?.revision ?? project.revision,
      expectedRevision,
    );
  }
}

async function finishMutation(
  tx: TransactionLike<PgQueryResultHKT>,
  project: typeof projects.$inferSelect,
  input: {
    expectedRevision: number;
    kind: "write" | "delete" | "rename" | "restore";
    changedPaths: string[];
  },
): Promise<ProjectMutationResult> {
  const revision = input.expectedRevision + 1;
  const revisionId = await insertRevision(tx, {
    projectId: project.id,
    revision,
    kind: input.kind,
  });
  const files = await tx
    .select({
      path: projectFiles.path,
      blobHash: projectFiles.blobHash,
    })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, project.id),
        isNull(projectFiles.deletedAt),
      ),
    )
    .orderBy(asc(projectFiles.path));

  if (files.length > 0) {
    await tx.insert(projectRevisionFiles).values(
      files.map((file) => ({
        revisionId,
        path: file.path,
        blobHash: file.blobHash,
      })),
    );
  }

  return { revision, changedPaths: input.changedPaths };
}

function throwRevisionConflict(
  actualRevision: number,
  expectedRevision: number,
): never {
  throw new ProjectError(
    PROJECT_ERROR_CODES.revisionConflict,
    "项目已经被其他操作更新，请重新读取后再保存。",
    409,
    { actualRevision, expectedRevision },
  );
}
