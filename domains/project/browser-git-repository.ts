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
    const allowCreate = await this.claimProvisionIfNeeded();

    try {
      this.state = await this.client.initialize({
        projectId: this.project.id,
        projectName: this.project.name,
        initialFiles: initialFiles.map((file) => ({
          path: assertValidProjectPath(file.path),
          content: file.content,
        })),
        allowCreate,
      });
      return this.state;
    } catch (error) {
      if (
        isProjectError(error) &&
        error.code === PROJECT_ERROR_CODES.storageUnavailable
      ) {
        await this.reportUnavailable(error.message);
      }
      throw error;
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

  private async claimProvisionIfNeeded(): Promise<boolean> {
    if (this.project.status !== "creating") {
      return false;
    }

    const response = await fetch(
      `/api/projects/${this.project.id}/browser-git/provision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "claim" }),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      allowCreate?: boolean;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw browserGitError(
        PROJECT_ERROR_CODES.storageUnavailable,
        body.error?.message ?? "Browser Git 首次创建许可获取失败。",
        response.status,
      );
    }

    return body.allowCreate === true;
  }

  private async reportUnavailable(reason: string): Promise<void> {
    try {
      await fetch(`/api/projects/${this.project.id}/browser-git/provision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unavailable", reason }),
      });
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
