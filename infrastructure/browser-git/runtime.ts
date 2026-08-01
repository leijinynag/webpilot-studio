import LightningFS from "@isomorphic-git/lightning-fs";
import * as git from "isomorphic-git";

import { assertValidProjectPath } from "@/domains/project/path";
import type {
  ProjectCheckpoint,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
} from "@/domains/project/types";
import type {
  BrowserGitChangedFile,
  BrowserGitCheckpointRecord,
  BrowserGitCommit,
  BrowserGitFileInput,
  BrowserGitRepositoryState,
  BrowserGitWorkerOperation,
  BrowserGitWorkerPayloadMap,
  BrowserGitWorkerRequest,
  BrowserGitWorkerResult,
} from "@/infrastructure/browser-git/protocol";

const REPOSITORY_DIRECTORY = "/repo";
const GIT_DIRECTORY = "/repo/.git";
const METADATA_DIRECTORY = "/metadata";
const CHECKPOINT_DIRECTORY = "/metadata/checkpoints";
const PROJECT_METADATA_PATH = "/metadata/project.json";
const DEFAULT_BRANCH = "main";
const SYSTEM_AUTHOR = {
  name: "WebPilot Studio",
  email: "system@webpilot.local",
};

type PromisifiedFS = LightningFS["promises"];

export type BrowserGitRuntimeOptions = {
  /**
   * 测试可通过 wipe 获得确定的空 IndexedDB；产品代码不传该选项，
   * 避免运行时意外清空用户本地仓库。
   */
  wipe?: boolean;
};

type BrowserGitProjectMetadata = {
  projectId: string;
  ownerId: string | null;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  unavailable: boolean;
  unavailableReason: string | null;
};

/**
 * 每个 Runtime 实例只打开一个项目对应的 LightningFS 数据库。
 * Git 对象、工作区与 checkpoint metadata 都落在同一个 IndexedDB 数据库中，
 * 但 metadata 位于仓库目录之外，因此不会进入 Git 提交、文件树或 Agent 工具。
 */
export class BrowserGitRuntime {
  private readonly lightningFs: LightningFS;
  private readonly fs: PromisifiedFS;

  constructor(
    readonly projectId: string,
    options: BrowserGitRuntimeOptions = {},
  ) {
    this.lightningFs = new LightningFS(
      `webpilot-browser-git-${projectId}`,
      options,
    );
    this.fs = this.lightningFs.promises;
  }

  async execute<TOperation extends BrowserGitWorkerOperation>(
    request: BrowserGitWorkerRequest<TOperation>,
  ): Promise<BrowserGitWorkerResult["data"]> {
    switch (request.operation) {
      case "initialize":
        return this.initialize(
          request.payload as BrowserGitWorkerPayloadMap["initialize"],
        );
      case "state":
        return this.getState();
      case "list_files":
        return this.listFiles();
      case "read_file":
        return this.readFile(
          (request.payload as BrowserGitWorkerPayloadMap["read_file"]).path,
        );
      case "search_text":
        return this.searchText(
          request.payload as BrowserGitWorkerPayloadMap["search_text"],
        );
      case "write_file":
        return this.writeFile(
          request.payload as BrowserGitWorkerPayloadMap["write_file"],
        );
      case "delete_file":
        return this.deleteFile(
          request.payload as BrowserGitWorkerPayloadMap["delete_file"],
        );
      case "rename_file":
        return this.renameFile(
          request.payload as BrowserGitWorkerPayloadMap["rename_file"],
        );
      case "stage":
        return this.stage(
          (request.payload as BrowserGitWorkerPayloadMap["stage"]).paths,
        );
      case "unstage":
        return this.unstage(
          (request.payload as BrowserGitWorkerPayloadMap["unstage"]).paths,
        );
      case "commit":
        return this.commit(
          request.payload as BrowserGitWorkerPayloadMap["commit"],
        );
      case "export":
        return this.exportRepository();
      case "create_checkpoint":
        return this.createCheckpoint(
          request.payload as BrowserGitWorkerPayloadMap["create_checkpoint"],
        );
      case "restore_checkpoint":
        return this.restoreCheckpoint(
          request.payload as BrowserGitWorkerPayloadMap["restore_checkpoint"],
        );
    }
  }

  async getRevision(): Promise<number> {
    const metadata = await this.readMetadata();
    return metadata.revision;
  }

  private async initialize(
    input: BrowserGitWorkerPayloadMap["initialize"],
  ): Promise<BrowserGitRepositoryState> {
    const existing = await this.tryReadMetadata();

    // 初始化是幂等操作。Worker 重启后重新收到 initialize 时只重开现有仓库，
    // 绝不清空 IndexedDB，也不会覆盖用户尚未提交的工作区。
    if (existing) {
      return this.getState();
    }

    if (!input.allowCreate) {
      throw workerDomainError(
        "STORAGE_UNAVAILABLE",
        "当前浏览器中找不到该 Browser Git 仓库，可能已清理站点数据。",
        { projectId: this.projectId },
      );
    }

    await ensureDirectory(this.fs, CHECKPOINT_DIRECTORY);
    await ensureDirectory(this.fs, REPOSITORY_DIRECTORY);
    await git.init({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
      defaultBranch: DEFAULT_BRANCH,
    });

    for (const file of input.initialFiles) {
      const path = assertValidProjectPath(file.path);
      await writeTextFile(this.fs, repositoryPath(path), file.content);
      await git.add({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
        filepath: path,
      });
    }

    if (input.initialFiles.length > 0) {
      await git.commit({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
        message: "Initialize project template",
        author: SYSTEM_AUTHOR,
      });
    }

    const now = new Date().toISOString();
    await this.writeMetadata({
      projectId: input.projectId,
      ownerId: null,
      name: normalizeProjectName(input.projectName),
      revision: input.initialFiles.length === 0 ? 0 : 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      unavailable: false,
      unavailableReason: null,
    });
    await this.fs.flush();

    return this.getState();
  }

  private async getState(): Promise<BrowserGitRepositoryState> {
    const metadata = await this.readMetadata();
    const branch =
      (await git.currentBranch({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
        fullname: false,
      })) ?? DEFAULT_BRANCH;
    const head = await this.tryResolveHead();
    const matrix = await git.statusMatrix({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
    });
    const files = await Promise.all(
      matrix
        .filter(([path, headStatus, worktreeStatus, stageStatus]) => {
          return (
            !isReservedRepositoryPath(path) &&
            !(headStatus === worktreeStatus && worktreeStatus === stageStatus)
          );
        })
        .map(([path, headStatus, worktreeStatus, stageStatus]) =>
          this.toChangedFile({
            path,
            headStatus,
            worktreeStatus,
            stageStatus,
          }),
        ),
    );

    return {
      projectId: this.projectId,
      revision: metadata.revision,
      branch,
      head,
      // 第一版不接 remote，ahead/behind 明确为 0，避免 UI 暗示已经同步远端。
      ahead: 0,
      behind: 0,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      commits: await this.readLog(),
      unavailable: metadata.unavailable,
      unavailableReason: metadata.unavailableReason,
    };
  }

  private async listFiles(): Promise<ProjectFileSnapshot[]> {
    const files = await this.readWorkingTree();
    const now = new Date().toISOString();

    return Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: file.content,
        byteLength: new TextEncoder().encode(file.content).byteLength,
        hash: await sha256(file.content),
        updatedAt: now,
      })),
    );
  }

  private async readFile(pathInput: string): Promise<ProjectFileSnapshot> {
    const path = assertValidProjectPath(pathInput);

    try {
      const content = await this.fs.readFile(repositoryPath(path), "utf8");
      const stats = await this.fs.stat(repositoryPath(path));

      return {
        path,
        content,
        byteLength: new TextEncoder().encode(content).byteLength,
        hash: await sha256(content),
        updatedAt: new Date(stats.mtimeMs).toISOString(),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        throw workerDomainError("FILE_NOT_FOUND", "项目文件不存在。", { path });
      }

      throw error;
    }
  }

  private async searchText(
    input: BrowserGitWorkerPayloadMap["search_text"],
  ): Promise<ProjectSearchMatch[]> {
    const query = input.query.trim();
    if (!query) {
      return [];
    }

    const files = await this.readWorkingTree();
    const matches: ProjectSearchMatch[] = [];
    let totalCharacters = 0;

    for (const file of files) {
      const lines = file.content.split(/\r?\n/);

      for (const [lineIndex, line] of lines.entries()) {
        const column = line.indexOf(query);
        if (column < 0) {
          continue;
        }

        const excerpt =
          line.length <= input.maxExcerptCharacters
            ? line
            : `${line.slice(0, Math.max(0, input.maxExcerptCharacters - 1))}…`;

        if (
          matches.length >= input.maxResults ||
          totalCharacters + excerpt.length > input.maxTotalCharacters
        ) {
          return matches;
        }

        matches.push({
          path: file.path,
          line: lineIndex + 1,
          column: column + 1,
          excerpt,
        });
        totalCharacters += excerpt.length;
      }
    }

    return matches;
  }

  private async writeFile(
    input: BrowserGitWorkerPayloadMap["write_file"],
  ): Promise<ProjectMutationResult> {
    const path = assertValidProjectPath(input.path);
    const metadata = await this.assertRevision(input.expectedRevision);

    await writeTextFile(this.fs, repositoryPath(path), input.content);
    return this.finishWorkspaceMutation(metadata, [path]);
  }

  private async deleteFile(
    input: BrowserGitWorkerPayloadMap["delete_file"],
  ): Promise<ProjectMutationResult> {
    const path = assertValidProjectPath(input.path);
    const metadata = await this.assertRevision(input.expectedRevision);

    try {
      await this.fs.unlink(repositoryPath(path));
    } catch (error) {
      if (isMissingFileError(error)) {
        throw workerDomainError("FILE_NOT_FOUND", "项目文件不存在。", { path });
      }
      throw error;
    }

    return this.finishWorkspaceMutation(metadata, [path]);
  }

  private async renameFile(
    input: BrowserGitWorkerPayloadMap["rename_file"],
  ): Promise<ProjectMutationResult> {
    const fromPath = assertValidProjectPath(input.fromPath);
    const toPath = assertValidProjectPath(input.toPath);
    const metadata = await this.assertRevision(input.expectedRevision);

    if (await pathExists(this.fs, repositoryPath(toPath))) {
      throw workerDomainError("PROJECT_PATH_CONFLICT", "目标文件路径已存在。", {
        fromPath,
        toPath,
      });
    }

    if (!(await pathExists(this.fs, repositoryPath(fromPath)))) {
      throw workerDomainError("FILE_NOT_FOUND", "项目文件不存在。", {
        path: fromPath,
      });
    }

    await ensureDirectory(this.fs, parentDirectory(repositoryPath(toPath)));
    await this.fs.rename(repositoryPath(fromPath), repositoryPath(toPath));
    return this.finishWorkspaceMutation(metadata, [fromPath, toPath]);
  }

  private async stage(paths: string[]): Promise<BrowserGitRepositoryState> {
    for (const rawPath of uniquePaths(paths)) {
      const path = assertValidProjectPath(rawPath);

      if (await pathExists(this.fs, repositoryPath(path))) {
        await git.add({
          fs: this.lightningFs,
          dir: REPOSITORY_DIRECTORY,
          filepath: path,
        });
      } else {
        // isomorphic-git 的 remove 只更新 index，不会重新触碰已经删除的工作区文件。
        await git.remove({
          fs: this.lightningFs,
          dir: REPOSITORY_DIRECTORY,
          filepath: path,
        });
      }
    }

    await this.fs.flush();
    return this.getState();
  }

  private async unstage(paths: string[]): Promise<BrowserGitRepositoryState> {
    const head = await this.tryResolveHead();

    for (const rawPath of uniquePaths(paths)) {
      const path = assertValidProjectPath(rawPath);
      const existsAtHead = head
        ? await this.pathExistsAtHead(head, path)
        : false;

      if (existsAtHead) {
        await git.resetIndex({
          fs: this.lightningFs,
          dir: REPOSITORY_DIRECTORY,
          filepath: path,
          ref: "HEAD",
        });
      } else {
        // HEAD 中不存在的新增文件，unstage 等价于从 index 移除，
        // 工作区内容仍保留为 untracked。
        await git.remove({
          fs: this.lightningFs,
          dir: REPOSITORY_DIRECTORY,
          filepath: path,
        });
      }
    }

    await this.fs.flush();
    return this.getState();
  }

  private async commit(
    input: BrowserGitWorkerPayloadMap["commit"],
  ): Promise<{ oid: string; state: BrowserGitRepositoryState }> {
    const message = input.message.trim();
    const authorName = input.authorName.trim();
    const authorEmail = input.authorEmail.trim();

    if (!message || !authorName || !authorEmail) {
      throw workerDomainError(
        "INVALID_REQUEST",
        "提交信息、作者姓名和邮箱都不能为空。",
      );
    }

    const hasStagedChanges = (
      await git.statusMatrix({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
      })
    ).some(([, headStatus, , stageStatus]) => headStatus !== stageStatus);

    if (!hasStagedChanges) {
      throw workerDomainError("INVALID_REQUEST", "没有可提交的暂存变更。");
    }

    const oid = await git.commit({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
      message,
      author: {
        name: authorName,
        email: authorEmail,
      },
    });
    await this.fs.flush();

    return { oid, state: await this.getState() };
  }

  private async createCheckpoint(
    input: BrowserGitWorkerPayloadMap["create_checkpoint"],
  ): Promise<ProjectCheckpoint> {
    const metadata =
      input.expectedRevision === undefined
        ? await this.readMetadata()
        : await this.assertRevision(input.expectedRevision);
    const checkpointId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const head = await this.tryResolveHead();
    const branch =
      (await git.currentBranch({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
        fullname: false,
      })) ?? DEFAULT_BRANCH;
    const indexBytes = await this.readIndexBytes();
    const record: BrowserGitCheckpointRecord & { indexContent: string } = {
      id: checkpointId,
      projectId: this.projectId,
      revision: metadata.revision,
      summary: input.summary?.trim() || null,
      manifest: await this.readWorkingTree(),
      head,
      indexHash: await sha256Bytes(indexBytes),
      indexContent: bytesToBase64(indexBytes),
      branch,
      createdAt,
      completedAt: null,
    };
    const checkpointPath = `${CHECKPOINT_DIRECTORY}/${checkpointId}.json`;

    try {
      // 先写入 incomplete 记录；只有内容全部持久化后才补 completedAt。
      // 因而浏览器崩溃留下的半成品不会被 restore 当成可用快照。
      await writeJsonFile(this.fs, checkpointPath, record);
      await this.fs.flush();
      record.completedAt = new Date().toISOString();
      await writeJsonFile(this.fs, checkpointPath, record);
      await this.fs.flush();
    } catch (error) {
      if (isQuotaExceededError(error)) {
        throw workerDomainError(
          "CHECKPOINT_QUOTA_EXCEEDED",
          "浏览器存储空间不足，checkpoint 已停止创建。请先导出仓库备份。",
        );
      }
      throw error;
    }

    return {
      id: checkpointId,
      projectId: this.projectId,
      runId: null,
      kind: "revision",
      revision: metadata.revision,
      summary: record.summary,
      createdAt,
    };
  }

  private async restoreCheckpoint(
    input: BrowserGitWorkerPayloadMap["restore_checkpoint"],
  ): Promise<ProjectMutationResult> {
    const metadata = await this.assertRevision(input.expectedRevision);
    const path = `${CHECKPOINT_DIRECTORY}/${input.checkpointId}.json`;
    let checkpoint: BrowserGitCheckpointRecord & { indexContent: string };

    try {
      checkpoint = await readJsonFile(this.fs, path);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw workerDomainError(
          "CHECKPOINT_NOT_FOUND",
          "项目 checkpoint 不存在。",
          { checkpointId: input.checkpointId },
        );
      }
      throw error;
    }

    if (!checkpoint.completedAt) {
      throw workerDomainError(
        "CHECKPOINT_NOT_FOUND",
        "项目 checkpoint 尚未完整写入，已忽略该记录。",
        { checkpointId: input.checkpointId },
      );
    }

    const currentFiles = await this.readWorkingTree();
    const checkpointPaths = new Set(
      checkpoint.manifest.map((file) => file.path),
    );
    const changedPaths = new Set<string>();

    for (const file of currentFiles) {
      if (!checkpointPaths.has(file.path)) {
        await this.fs.unlink(repositoryPath(file.path));
        changedPaths.add(file.path);
      }
    }

    for (const file of checkpoint.manifest) {
      const current = currentFiles.find(
        (candidate) => candidate.path === file.path,
      );
      if (!current || current.content !== file.content) {
        await writeTextFile(this.fs, repositoryPath(file.path), file.content);
        changedPaths.add(file.path);
      }
    }

    // 只恢复 index 原始内容。HEAD、当前分支指针与 reflog 都不写入，
    // 即使 checkpoint 创建后又产生了 commit，恢复也不会改写历史。
    await writeBinaryFile(
      this.fs,
      `${GIT_DIRECTORY}/index`,
      base64ToBytes(checkpoint.indexContent),
    );
    return this.finishWorkspaceMutation(metadata, [...changedPaths].sort());
  }

  private async exportRepository(): Promise<{
    archive: string;
    fileCount: number;
  }> {
    const entries = await readAllEntries(this.fs, REPOSITORY_DIRECTORY);
    const metadata = await this.readMetadata();

    return {
      archive: JSON.stringify(
        {
          format: "webpilot-browser-git-backup-v1",
          exportedAt: new Date().toISOString(),
          project: metadata,
          entries,
        },
        null,
        2,
      ),
      fileCount: entries.length,
    };
  }

  private async finishWorkspaceMutation(
    metadata: BrowserGitProjectMetadata,
    changedPaths: string[],
  ): Promise<ProjectMutationResult> {
    const revision = metadata.revision + 1;
    await this.writeMetadata({
      ...metadata,
      revision,
      updatedAt: new Date().toISOString(),
      unavailable: false,
      unavailableReason: null,
    });
    await this.fs.flush();
    return { revision, changedPaths };
  }

  private async assertRevision(
    expectedRevision: number,
  ): Promise<BrowserGitProjectMetadata> {
    const metadata = await this.readMetadata();

    if (metadata.revision !== expectedRevision) {
      throw workerDomainError(
        "PROJECT_REVISION_CONFLICT",
        "项目已被其他操作更新，请刷新后重试。",
        {
          expectedRevision,
          actualRevision: metadata.revision,
        },
      );
    }

    return metadata;
  }

  private async readMetadata(): Promise<BrowserGitProjectMetadata> {
    const metadata = await this.tryReadMetadata();

    if (!metadata) {
      throw workerDomainError(
        "STORAGE_UNAVAILABLE",
        "当前浏览器中找不到该 Browser Git 仓库，可能已清理站点数据。",
        { projectId: this.projectId },
      );
    }

    if (!(await pathExists(this.fs, GIT_DIRECTORY))) {
      throw workerDomainError(
        "STORAGE_UNAVAILABLE",
        "Browser Git 元数据存在，但 Git 数据目录已经丢失。",
        { projectId: this.projectId },
      );
    }

    return metadata;
  }

  private async tryReadMetadata(): Promise<BrowserGitProjectMetadata | null> {
    try {
      return await readJsonFile<BrowserGitProjectMetadata>(
        this.fs,
        PROJECT_METADATA_PATH,
      );
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async writeMetadata(metadata: BrowserGitProjectMetadata) {
    await ensureDirectory(this.fs, METADATA_DIRECTORY);
    await writeJsonFile(this.fs, PROJECT_METADATA_PATH, metadata);
  }

  private async readWorkingTree(): Promise<BrowserGitFileInput[]> {
    return readTextFiles(this.fs, REPOSITORY_DIRECTORY, {
      excludeDirectories: new Set([".git", "node_modules"]),
    });
  }

  private async tryResolveHead(): Promise<string | null> {
    try {
      return await git.resolveRef({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
        ref: "HEAD",
      });
    } catch {
      return null;
    }
  }

  private async readLog(): Promise<BrowserGitCommit[]> {
    if (!(await this.tryResolveHead())) {
      return [];
    }

    const commits = await git.log({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
      depth: 30,
    });

    return commits.map(({ oid, commit }) => ({
      oid,
      message: commit.message.trim(),
      author: {
        name: commit.author.name,
        email: commit.author.email,
        timestamp: commit.author.timestamp,
      },
      committer: {
        name: commit.committer.name,
        email: commit.committer.email,
        timestamp: commit.committer.timestamp,
      },
      parent: commit.parent[0] ?? null,
    }));
  }

  private async toChangedFile(input: {
    path: string;
    headStatus: number;
    worktreeStatus: number;
    stageStatus: number;
  }): Promise<BrowserGitChangedFile> {
    const oldContent =
      input.headStatus === 0
        ? null
        : await this.readHeadContent(input.path).catch(() => null);
    const newContent =
      input.worktreeStatus === 0
        ? null
        : await this.fs
            .readFile(repositoryPath(input.path), "utf8")
            .catch(() => null);
    const stagedContent =
      input.stageStatus === 0
        ? null
        : await this.readIndexContent(input.path).catch(() => null);
    const counts = countLineChanges(oldContent, newContent);

    return {
      path: input.path,
      status: inferFileStatus(input),
      staged: input.headStatus !== input.stageStatus,
      unstaged: input.worktreeStatus !== input.stageStatus,
      oldContent,
      newContent,
      stagedContent,
      additions: counts.additions,
      deletions: counts.deletions,
    };
  }

  private async readHeadContent(path: string): Promise<string> {
    const head = await this.tryResolveHead();
    if (!head) {
      throw new Error("HEAD is not available.");
    }

    const result = await git.readBlob({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
      oid: head,
      filepath: path,
    });
    return new TextDecoder().decode(result.blob);
  }

  private async readIndexContent(path: string): Promise<string> {
    const entries = (await git.walk({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
      trees: [git.STAGE()],
      map: async (_filepath, [entry]) => {
        if (!entry) {
          return null;
        }
        return entry;
      },
    })) as Array<{
      path?: string;
      type?: string;
      oid?: string;
    } | null>;
    const entry = entries.find((candidate) => candidate?.path === path);

    if (!entry || entry.type !== "blob" || !entry.oid) {
      throw new Error("The file is not present in the index.");
    }

    const blob = await git.readBlob({
      fs: this.lightningFs,
      dir: REPOSITORY_DIRECTORY,
      oid: entry.oid,
    });
    return new TextDecoder().decode(blob.blob);
  }

  private async pathExistsAtHead(head: string, path: string): Promise<boolean> {
    try {
      await git.readBlob({
        fs: this.lightningFs,
        dir: REPOSITORY_DIRECTORY,
        oid: head,
        filepath: path,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async readIndexBytes(): Promise<Uint8Array> {
    try {
      return await this.fs.readFile(`${GIT_DIRECTORY}/index`);
    } catch (error) {
      if (isMissingFileError(error)) {
        return new Uint8Array();
      }
      throw error;
    }
  }
}

function inferFileStatus(input: {
  headStatus: number;
  worktreeStatus: number;
}): BrowserGitChangedFile["status"] {
  if (input.headStatus === 0) {
    return input.worktreeStatus === 0 ? "deleted" : "untracked";
  }
  if (input.worktreeStatus === 0) {
    return "deleted";
  }
  return "modified";
}

function countLineChanges(
  oldContent: string | null,
  newContent: string | null,
) {
  if (oldContent === null) {
    return { additions: splitLines(newContent).length, deletions: 0 };
  }
  if (newContent === null) {
    return { additions: 0, deletions: splitLines(oldContent).length };
  }

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  let sharedPrefix = 0;
  while (
    sharedPrefix < oldLines.length &&
    sharedPrefix < newLines.length &&
    oldLines[sharedPrefix] === newLines[sharedPrefix]
  ) {
    sharedPrefix += 1;
  }
  let sharedSuffix = 0;
  while (
    sharedSuffix < oldLines.length - sharedPrefix &&
    sharedSuffix < newLines.length - sharedPrefix &&
    oldLines[oldLines.length - 1 - sharedSuffix] ===
      newLines[newLines.length - 1 - sharedSuffix]
  ) {
    sharedSuffix += 1;
  }

  return {
    additions: newLines.length - sharedPrefix - sharedSuffix,
    deletions: oldLines.length - sharedPrefix - sharedSuffix,
  };
}

function splitLines(content: string | null): string[] {
  if (!content) {
    return [];
  }
  return content.replace(/\n$/, "").split("\n");
}

async function readTextFiles(
  fs: PromisifiedFS,
  directory: string,
  options: { excludeDirectories: Set<string> },
  relativeDirectory = "",
): Promise<BrowserGitFileInput[]> {
  const names = await fs.readdir(directory);
  const files: BrowserGitFileInput[] = [];

  for (const name of names.sort()) {
    if (options.excludeDirectories.has(name)) {
      continue;
    }
    const absolutePath = `${directory}/${name}`;
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${name}`
      : name;
    const stats = await fs.stat(absolutePath);

    if (stats.isDirectory()) {
      files.push(
        ...(await readTextFiles(fs, absolutePath, options, relativePath)),
      );
    } else {
      files.push({
        path: relativePath,
        content: await fs.readFile(absolutePath, "utf8"),
      });
    }
  }

  return files;
}

async function readAllEntries(
  fs: PromisifiedFS,
  directory: string,
  relativeDirectory = "",
): Promise<Array<{ path: string; content: string }>> {
  const names = await fs.readdir(directory);
  const entries: Array<{ path: string; content: string }> = [];

  for (const name of names.sort()) {
    const absolutePath = `${directory}/${name}`;
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${name}`
      : name;
    const stats = await fs.stat(absolutePath);

    if (stats.isDirectory()) {
      entries.push(...(await readAllEntries(fs, absolutePath, relativePath)));
    } else {
      entries.push({
        path: relativePath,
        content: bytesToBase64(await fs.readFile(absolutePath)),
      });
    }
  }

  return entries;
}

async function writeTextFile(fs: PromisifiedFS, path: string, content: string) {
  await ensureDirectory(fs, parentDirectory(path));
  await fs.writeFile(path, content, "utf8");
}

async function writeBinaryFile(
  fs: PromisifiedFS,
  path: string,
  content: Uint8Array,
) {
  await ensureDirectory(fs, parentDirectory(path));
  await fs.writeFile(path, content);
}

async function writeJsonFile(fs: PromisifiedFS, path: string, value: unknown) {
  await writeTextFile(fs, path, JSON.stringify(value));
}

async function readJsonFile<T>(fs: PromisifiedFS, path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, "utf8")) as T;
}

async function ensureDirectory(fs: PromisifiedFS, directory: string) {
  const segments = directory.split("/").filter(Boolean);
  let current = "";

  for (const segment of segments) {
    current += `/${segment}`;
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }
}

async function pathExists(fs: PromisifiedFS, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function repositoryPath(path: string) {
  return `${REPOSITORY_DIRECTORY}/${path}`;
}

function parentDirectory(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function normalizeProjectName(name: string) {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120) {
    throw workerDomainError(
      "INVALID_REQUEST",
      "项目名称不能为空且不能超过 120 个字符。",
    );
  }
  return normalized;
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths)].sort();
}

function isReservedRepositoryPath(path: string) {
  return path === ".git" || path.startsWith(".git/");
}

function isMissingFileError(error: unknown) {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown) {
  return hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isQuotaExceededError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.code === 22)
  );
}

async function sha256(content: string) {
  return sha256Bytes(new TextEncoder().encode(content));
}

async function sha256Bytes(content: Uint8Array) {
  // TS 5.9 在 DOM lib 中要求 ArrayBuffer 而不是 ArrayBufferLike；
  // 复制一份到稳定的 ArrayBuffer，兼容 Worker 和主线程的类型定义。
  const stableBuffer = new Uint8Array(content.byteLength);
  stableBuffer.set(content);
  const digest = await crypto.subtle.digest("SHA-256", stableBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class BrowserGitWorkerDomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BrowserGitWorkerDomainError";
  }
}

function workerDomainError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return new BrowserGitWorkerDomainError(code, message, details);
}
