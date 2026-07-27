import { createHash } from "node:crypto";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core/session";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

import {
  projectFileBlobs,
  projectFiles,
  projectRevisionFiles,
  projectRevisions,
  projects,
} from "@/infrastructure/db/schema";
import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";
import { assertValidProjectPath } from "@/domains/project/path";
import type {
  ProjectCheckpoint,
  ProjectDescription,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
  ProjectSearchOptions,
  ProjectStorageKind,
  ProjectSummary,
} from "@/domains/project/types";
import { databaseSchema } from "@/infrastructure/db/schema";

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

    if (input.initialFiles.length === 0) {
      throw new ProjectError(
        PROJECT_ERROR_CODES.invalidRequest,
        "新项目至少需要一个初始文件。",
        400,
      );
    }

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
          status: "ready",
          revision: 1,
        })
        .returning();

      if (!project) {
        throw new Error("创建项目失败。");
      }

      const revisionId = await insertRevision(tx, {
        projectId: project.id,
        revision: 1,
        kind: "initial",
        summary: "Initialize project template",
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
    const project = await this.getProject(input);

    await this.db
      .update(projects)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(projects.id, project.id), eq(projects.ownerId, input.ownerId)),
      );
  }

  async restoreProject(input: {
    ownerId: string;
    projectId: string;
  }): Promise<void> {
    const project = await this.getProject({
      ...input,
      includeDeleted: true,
    });

    if (!project.deletedAt) {
      return;
    }

    await this.db
      .update(projects)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(
        and(eq(projects.id, project.id), eq(projects.ownerId, input.ownerId)),
      );
  }

  async listFiles(input: {
    ownerId: string;
    projectId: string;
  }): Promise<ProjectFileSnapshot[]> {
    const project = await this.getProject(input);
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

  async createCheckpoint(input: {
    ownerId: string;
    projectId: string;
    summary?: string;
    expectedRevision?: number;
  }): Promise<ProjectCheckpoint> {
    const project = await this.getProject(input);

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
