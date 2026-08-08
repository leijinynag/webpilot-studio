"use client";

import { browserGitError } from "@/infrastructure/browser-git/errors";
import { getBrowserGitClient } from "@/infrastructure/browser-git/client";
import type {
  BrowserGitChangedFile,
  BrowserGitCommit,
  BrowserGitRepositoryState,
} from "@/infrastructure/browser-git/protocol";
import type {
  ProjectCheckpoint,
  ProjectDescription,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
  ProjectSearchOptions,
  ProjectSummary,
} from "@/domains/project/types";
import { isProjectError, PROJECT_ERROR_CODES } from "@/domains/project/errors";
import { assertValidProjectPath } from "@/domains/project/path";
import { browserApiFetch } from "@/infrastructure/http/browser-api";

/**
 * 同一个工作台可能因为 React Strict Mode、路由切换或重复挂载，
 * 在很短时间内创建多个 Repository 实例。
 *
 * Browser Git 的首次 provision claim 是服务端一次性操作，而 Worker
 * 初始化还需要异步创建 IndexedDB 文件系统。这里按 projectId 合并整条
 * 初始化链，避免第二个调用在第一个调用完成前拿到 allowCreate=false。
 */
const browserGitInitializationPromises = new Map<
  string,
  Promise<BrowserGitRepositoryState>
>();

/**
 * Browser Git 适配器只在客户端创建。
 *
 * 服务端的 ProjectDescription 是项目索引，BrowserGitClient 才是源码事实来源。
 * 因此这里所有文件操作都不再请求 /api/projects/:id/files，避免本地仓库和
 * PostgreSQL Repository 形成两个互相覆盖的 revision。
 */
export class BrowserGitProjectRepository {
  private readonly client = getBrowserGitClient();
  private state: BrowserGitRepositoryState | null = null;

  constructor(private readonly project: ProjectDescription) {
    if (project.storageKind !== "browser_git") {
      throw browserGitError(
        PROJECT_ERROR_CODES.storageUnavailable,
        "当前项目不是 Browser Git 项目。",
        409,
      );
    }
  }

  async initialize(
    initialFiles: readonly { path: string; content: string }[] = [],
  ) {
    const existingInitialization = browserGitInitializationPromises.get(
      this.project.id,
    );
    const initialization =
      existingInitialization ?? this.createInitializationPromise(initialFiles);

    if (!existingInitialization) {
      browserGitInitializationPromises.set(this.project.id, initialization);
    }

    try {
      this.state = await initialization;
      return this.state;
    } finally {
      // 只合并同一批并发调用。完成后释放引用，避免长期持有项目状态，
      // 同时让失败后的下一次打开能够重新执行 provision 和 Worker 初始化。
      if (
        browserGitInitializationPromises.get(this.project.id) === initialization
      ) {
        browserGitInitializationPromises.delete(this.project.id);
      }
    }
  }

  async getGitState(): Promise<BrowserGitRepositoryState> {
    this.state = await this.client.getState(this.project.id);
    return this.state;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    throw browserGitError(
      PROJECT_ERROR_CODES.storageUnavailable,
      "Browser Git 项目列表由服务端项目索引提供。",
      409,
    );
  }

  async createProject(): Promise<ProjectDescription> {
    throw browserGitError(
      PROJECT_ERROR_CODES.storageUnavailable,
      "Browser Git 项目必须先通过项目创建 API 建立项目索引。",
      409,
    );
  }

  async describe(): Promise<ProjectDescription> {
    const state = await this.getGitState();
    return {
      ...this.project,
      revision: state.revision,
      fileCount: await this.countWorkingTreeFiles(),
      updatedAt: new Date().toISOString(),
    };
  }

  async renameProject(): Promise<ProjectMutationResult> {
    throw browserGitError(
      PROJECT_ERROR_CODES.storageUnavailable,
      "Browser Git 项目名称由服务端项目索引维护。",
      409,
    );
  }

  async deleteProject(): Promise<void> {
    throw browserGitError(
      PROJECT_ERROR_CODES.storageUnavailable,
      "Browser Git 项目删除请通过项目 API 完成。",
      409,
    );
  }

  async restoreProject(): Promise<void> {
    throw browserGitError(
      PROJECT_ERROR_CODES.storageUnavailable,
      "Browser Git 项目恢复请通过项目 API 完成。",
      409,
    );
  }

  async listFiles(): Promise<ProjectFileSnapshot[]> {
    return this.client.listFiles(this.project.id) as Promise<
      ProjectFileSnapshot[]
    >;
  }

  async readFile(input: { path: string }): Promise<ProjectFileSnapshot> {
    return this.client.readFile(
      this.project.id,
      assertValidProjectPath(input.path),
    ) as Promise<ProjectFileSnapshot>;
  }

  async searchText(input: {
    query: string;
    options?: ProjectSearchOptions;
  }): Promise<ProjectSearchMatch[]> {
    return this.client.searchText(this.project.id, {
      query: input.query,
      maxResults: input.options?.maxResults ?? 100,
      maxExcerptCharacters: input.options?.maxExcerptCharacters ?? 240,
      maxTotalCharacters: input.options?.maxTotalCharacters ?? 20_000,
    }) as Promise<ProjectSearchMatch[]>;
  }

  async writeFile(input: {
    path: string;
    content: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    return this.client.writeFile(this.project.id, {
      path: assertValidProjectPath(input.path),
      content: input.content,
      expectedRevision: input.expectedRevision,
    }) as Promise<ProjectMutationResult>;
  }

  async deleteFile(input: {
    path: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    return this.client.deleteFile(this.project.id, {
      path: assertValidProjectPath(input.path),
      expectedRevision: input.expectedRevision,
    }) as Promise<ProjectMutationResult>;
  }

  async renameFile(input: {
    fromPath: string;
    toPath: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    return this.client.renameFile(this.project.id, {
      fromPath: assertValidProjectPath(input.fromPath),
      toPath: assertValidProjectPath(input.toPath),
      expectedRevision: input.expectedRevision,
    }) as Promise<ProjectMutationResult>;
  }

  async createCheckpoint(input: {
    summary?: string;
    expectedRevision?: number;
  }): Promise<ProjectCheckpoint> {
    return this.client.createCheckpoint(
      this.project.id,
      input,
    ) as Promise<ProjectCheckpoint>;
  }

  async restoreCheckpoint(input: {
    checkpointId: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult> {
    return this.client.restoreCheckpoint(
      this.project.id,
      input,
    ) as Promise<ProjectMutationResult>;
  }

  async stage(paths: readonly string[]) {
    return this.client.stage(
      this.project.id,
      paths.map(assertValidProjectPath),
    );
  }

  async unstage(paths: readonly string[]) {
    return this.client.unstage(
      this.project.id,
      paths.map(assertValidProjectPath),
    );
  }

  async commit(input: {
    message: string;
    authorName: string;
    authorEmail: string;
  }) {
    return this.client.commit(this.project.id, input);
  }

  async export() {
    return this.client.export(this.project.id);
  }

  private async countWorkingTreeFiles() {
    return (await this.listFiles()).length;
  }

  private createInitializationPromise(
    initialFiles: readonly { path: string; content: string }[],
  ): Promise<BrowserGitRepositoryState> {
    return (async () => {
      const provision = await this.claimProvisionIfNeeded();
      const provisionFiles =
        provision.allowCreate && provision.initialFiles.length > 0
          ? provision.initialFiles
          : initialFiles;

      try {
        return await this.client.initialize({
          projectId: this.project.id,
          projectName: this.project.name,
          initialFiles: provisionFiles.map((file) => ({
            path: assertValidProjectPath(file.path),
            content: file.content,
          })),
          allowCreate: provision.allowCreate,
        });
      } catch (error) {
        if (
          isProjectError(error) &&
          error.code === PROJECT_ERROR_CODES.storageUnavailable
        ) {
          // 错误处理也属于共享初始化链，多个等待者只会上报一次。
          await this.reportUnavailable(error.message);
        }
        throw error;
      }
    })();
  }

  private async claimProvisionIfNeeded(): Promise<{
    allowCreate: boolean;
    initialFiles: Array<{ path: string; content: string }>;
  }> {
    if (this.project.status !== "creating") {
      return { allowCreate: false, initialFiles: [] };
    }

    const response = await browserApiFetch(
      `/api/projects/${this.project.id}/browser-git/provision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "claim" }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      allowCreate?: boolean;
      initialFiles?: Array<{ path: string; content: string }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw browserGitError(
        PROJECT_ERROR_CODES.storageUnavailable,
        body.error?.message ?? "Browser Git 首次创建许可获取失败。",
        response.status,
      );
    }

    return {
      allowCreate: body.allowCreate === true,
      initialFiles: Array.isArray(body.initialFiles) ? body.initialFiles : [],
    };
  }

  private async reportUnavailable(reason: string): Promise<void> {
    try {
      await browserApiFetch(
        `/api/projects/${this.project.id}/browser-git/provision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "unavailable", reason }),
        },
      );
    } catch {
      // 服务端状态上报只是辅助索引，不能覆盖 Worker 返回的本地数据丢失错误。
    }
  }
}

export type BrowserGitChangeGroup = {
  staged: BrowserGitChangedFile[];
  unstaged: BrowserGitChangedFile[];
  untracked: BrowserGitChangedFile[];
};

export function groupBrowserGitChanges(
  files: readonly BrowserGitChangedFile[],
): BrowserGitChangeGroup {
  const groups: BrowserGitChangeGroup = {
    staged: [],
    unstaged: [],
    untracked: [],
  };

  for (const file of files) {
    if (file.status === "untracked" && !file.staged) {
      groups.untracked.push(file);
      continue;
    }

    if (file.staged) {
      groups.staged.push(file);
    }

    if (file.unstaged) {
      groups.unstaged.push(file);
    }
  }

  return groups;
}

export function getChangedFileContent(
  file: BrowserGitChangedFile,
  mode: "staged" | "working",
) {
  return mode === "staged"
    ? { before: file.oldContent, after: file.stagedContent }
    : { before: file.stagedContent, after: file.newContent };
}

export function formatCommitShortOid(commit: BrowserGitCommit) {
  return commit.oid.slice(0, 7);
}
