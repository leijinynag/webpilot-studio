import "fake-indexeddb/auto";

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { deserializeBrowserGitError } from "@/infrastructure/browser-git/errors";
import {
  BrowserGitRuntime,
  BrowserGitWorkerDomainError,
} from "@/infrastructure/browser-git/runtime";
import type {
  BrowserGitRepositoryState,
  BrowserGitWorkerOperation,
  BrowserGitWorkerPayloadMap,
  BrowserGitWorkerRequest,
} from "@/infrastructure/browser-git/protocol";
import type { ProjectContentRepository } from "@/tests/contract/project-repository-contract";
import { describeProjectContentRepositoryContract } from "@/tests/contract/project-repository-contract";
import type {
  ProjectCheckpoint,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
} from "@/domains/project/types";
import { PROJECT_ERROR_CODES } from "@/domains/project/errors";

describeProjectContentRepositoryContract("Browser Git", async () => {
  const projectId = randomUUID();
  const runtime = new BrowserGitRuntime(projectId, { wipe: true });

  const execute = async <TOperation extends BrowserGitWorkerOperation>(
    operation: TOperation,
    payload: BrowserGitWorkerPayloadMap[TOperation],
  ) => {
    const request: BrowserGitWorkerRequest<TOperation> = {
      protocol: "webpilot.browser-git.v1",
      type: "request",
      requestId: randomUUID(),
      projectId,
      operation,
      payload,
    };

    try {
      return await runtime.execute(request);
    } catch (error) {
      if (error instanceof BrowserGitWorkerDomainError) {
        throw deserializeBrowserGitError({
          code: error.code,
          message: error.message,
          details: error.details,
        });
      }
      throw error;
    }
  };

  const repository: ProjectContentRepository = {
    async initialize(initialFiles) {
      const state = await execute("initialize", {
        projectId,
        projectName: "Browser Git contract",
        initialFiles: [...initialFiles],
        allowCreate: true,
      });
      return {
        revision: "revision" in state ? state.revision : 0,
        fileCount: (await repository.listFiles()).length,
      };
    },
    getRevision: () => runtime.getRevision(),
    listFiles: () =>
      execute("list_files", {}) as Promise<ProjectFileSnapshot[]>,
    readFile: (path) =>
      execute("read_file", { path }) as Promise<ProjectFileSnapshot>,
    searchText: (query, options) =>
      execute("search_text", {
        query,
        maxResults: options?.maxResults ?? 100,
        maxExcerptCharacters: options?.maxExcerptCharacters ?? 240,
        maxTotalCharacters: options?.maxTotalCharacters ?? 20_000,
      }) as Promise<ProjectSearchMatch[]>,
    writeFile: (input) =>
      execute("write_file", input) as Promise<ProjectMutationResult>,
    deleteFile: (input) =>
      execute("delete_file", input) as Promise<ProjectMutationResult>,
    renameFile: (input) =>
      execute("rename_file", input) as Promise<ProjectMutationResult>,
    createCheckpoint: (input) =>
      execute("create_checkpoint", input) as Promise<ProjectCheckpoint>,
    restoreCheckpoint: (input) =>
      execute("restore_checkpoint", input) as Promise<ProjectMutationResult>,
  };

  return {
    repository,
    // 每个 fixture 使用随机 IndexedDB 名称且首次构造 wipe，互不污染。
    close: async () => {},
  };
});

describe("Browser Git provision recovery boundary", () => {
  it("does not recreate a missing repository without an explicit claim", async () => {
    const projectId = randomUUID();
    const runtime = new BrowserGitRuntime(projectId, { wipe: true });
    const request: BrowserGitWorkerRequest<"initialize"> = {
      protocol: "webpilot.browser-git.v1",
      type: "request",
      requestId: randomUUID(),
      projectId,
      operation: "initialize",
      payload: {
        projectId,
        projectName: "Missing repository",
        initialFiles: [],
        allowCreate: false,
      },
    };

    await expect(runtime.execute(request)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await expect(runtime.getRevision()).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("maps Worker revision conflicts to the shared domain code", () => {
    expect(
      deserializeBrowserGitError({
        code: "PROJECT_REVISION_CONFLICT",
        message: "conflict",
      }),
    ).toMatchObject({ code: PROJECT_ERROR_CODES.revisionConflict });
  });
});

describe("Browser Git source control workflow", () => {
  it("commits staged files and restores the clean history after a runtime restart", async () => {
    const projectId = randomUUID();
    const runtime = new BrowserGitRuntime(projectId, { wipe: true });
    const execute = async <TOperation extends BrowserGitWorkerOperation>(
      targetRuntime: BrowserGitRuntime,
      operation: TOperation,
      payload: BrowserGitWorkerPayloadMap[TOperation],
    ) =>
      targetRuntime.execute({
        protocol: "webpilot.browser-git.v1",
        type: "request",
        requestId: randomUUID(),
        projectId,
        operation,
        payload,
      });

    await execute(runtime, "initialize", {
      projectId,
      projectName: "Source control workflow",
      initialFiles: [],
      allowCreate: true,
    });
    await execute(runtime, "write_file", {
      path: "README.md",
      // 空文件曾在浏览器 QA 中触发过一次提交等待，保留为回归样例，
      // 同时确保 index 中的零字节 blob 可以正常形成首个 commit。
      content: "",
      expectedRevision: 0,
    });

    const stagedState = await execute(runtime, "stage", {
      paths: ["README.md"],
    });
    expect(stagedState).toMatchObject({
      head: null,
      files: [
        {
          path: "README.md",
          staged: true,
          unstaged: false,
        },
      ],
      commits: [],
    });

    const committed = (await execute(runtime, "commit", {
      message: "test: commit empty readme",
      authorName: "WebPilot Tester",
      authorEmail: "tester@webpilot.local",
    })) as {
      oid: string;
      state: BrowserGitRepositoryState;
    };
    expect(committed).toMatchObject({
      oid: expect.any(String),
      state: {
        files: [],
        commits: [
          {
            message: "test: commit empty readme",
            author: {
              name: "WebPilot Tester",
              email: "tester@webpilot.local",
            },
            parent: null,
          },
        ],
      },
    });

    // 模拟页面刷新或 Worker 重启：新 Runtime 不传 wipe，并且不允许重新创建。
    // 初始化必须打开原 IndexedDB，而不是生成一个同 ID 的空仓库。
    const restartedRuntime = new BrowserGitRuntime(projectId);
    const restoredState = await execute(restartedRuntime, "initialize", {
      projectId,
      projectName: "Source control workflow",
      initialFiles: [],
      allowCreate: false,
    });
    expect(restoredState).toMatchObject({
      head: committed.oid,
      files: [],
      commits: [
        {
          oid: committed.oid,
          message: "test: commit empty readme",
        },
      ],
    });
  });

  it("restores checkpoint files and index without moving the current Git HEAD", async () => {
    const projectId = randomUUID();
    const runtime = new BrowserGitRuntime(projectId, { wipe: true });
    const execute = async <TOperation extends BrowserGitWorkerOperation>(
      operation: TOperation,
      payload: BrowserGitWorkerPayloadMap[TOperation],
    ) =>
      runtime.execute({
        protocol: "webpilot.browser-git.v1",
        type: "request",
        requestId: randomUUID(),
        projectId,
        operation,
        payload,
      });

    await execute("initialize", {
      projectId,
      projectName: "Checkpoint keeps Git history",
      initialFiles: [],
      allowCreate: true,
    });
    await execute("write_file", {
      path: "README.md",
      content: "# Revision A\n",
      expectedRevision: 0,
    });
    await execute("stage", { paths: ["README.md"] });
    const firstCommit = (await execute("commit", {
      message: "test: create revision A",
      authorName: "WebPilot Tester",
      authorEmail: "tester@webpilot.local",
    })) as {
      oid: string;
      state: BrowserGitRepositoryState;
    };
    const checkpoint = (await execute("create_checkpoint", {
      summary: "Checkpoint at revision A",
      expectedRevision: 1,
    })) as ProjectCheckpoint;

    await execute("write_file", {
      path: "README.md",
      content: "# Revision B\n",
      expectedRevision: 1,
    });
    await execute("stage", { paths: ["README.md"] });
    const secondCommit = (await execute("commit", {
      message: "test: create revision B",
      authorName: "WebPilot Tester",
      authorEmail: "tester@webpilot.local",
    })) as {
      oid: string;
      state: BrowserGitRepositoryState;
    };

    const restored = await execute("restore_checkpoint", {
      checkpointId: checkpoint.id,
      expectedRevision: 2,
    });
    const [restoredFile, restoredState] = await Promise.all([
      execute("read_file", { path: "README.md" }),
      execute("state", {}),
    ]);

    expect(restored).toMatchObject({
      revision: 3,
      changedPaths: ["README.md"],
    });
    expect(restoredFile).toMatchObject({ content: "# Revision A\n" });
    expect(restoredState).toMatchObject({
      revision: 3,
      branch: "main",
      // checkpoint 只恢复工作区与 index。用户在 checkpoint 之后创建的
      // commit B 仍然是当前 HEAD，历史与分支指针都不允许被 restore 改写。
      head: secondCommit.oid,
      files: [
        {
          path: "README.md",
          staged: true,
          unstaged: false,
          newContent: "# Revision A\n",
        },
      ],
      commits: [
        {
          oid: secondCommit.oid,
          parent: firstCommit.oid,
          message: "test: create revision B",
        },
        {
          oid: firstCommit.oid,
          parent: null,
          message: "test: create revision A",
        },
      ],
    });
  });
});

describe("Browser Git migration candidate", () => {
  it("creates a clean candidate and promotes the same HEAD to the project repository", async () => {
    const candidateId = `migration-${randomUUID()}`;
    const projectId = randomUUID();
    const candidate = new BrowserGitRuntime(candidateId, { wipe: true });
    const files = [
      { path: "README.md", content: "# Migrated\n" },
      {
        path: "src/index.ts",
        content: "export const migrated = true;\n",
      },
    ];
    const manifestHash = await manifestHashFor(files);
    const candidateState = await candidate.initializeMigrationCandidate({
      projectName: "Migrated project",
      sourceRevision: 7,
      manifestHash,
      initialFiles: files,
    });

    expect(candidateState).toMatchObject({
      repositoryId: candidateId,
      revision: 7,
      branch: "main",
      clean: true,
      manifestHash,
      fileCount: 2,
      head: expect.any(String),
    });

    const targetRuntimes = new Map<string, BrowserGitRuntime>();
    const promoted = await candidate.promoteMigrationCandidate(
      {
        targetProjectId: projectId,
        projectName: "Migrated project",
        sourceRevision: 7,
        manifestHash,
        head: candidateState.head,
      },
      (targetProjectId) => {
        const runtime =
          targetRuntimes.get(targetProjectId) ??
          new BrowserGitRuntime(targetProjectId, { wipe: true });
        targetRuntimes.set(targetProjectId, runtime);
        return runtime;
      },
    );

    expect(promoted).toMatchObject({
      repositoryId: projectId,
      revision: 7,
      head: candidateState.head,
      clean: true,
      manifestHash,
    });

    const restarted = new BrowserGitRuntime(projectId);
    const restored = await restarted.execute({
      protocol: "webpilot.browser-git.v1",
      type: "request",
      requestId: randomUUID(),
      projectId,
      operation: "initialize",
      payload: {
        projectId,
        projectName: "Migrated project",
        initialFiles: [],
        allowCreate: false,
      },
    });
    const restoredFiles = (await restarted.execute({
      protocol: "webpilot.browser-git.v1",
      type: "request",
      requestId: randomUUID(),
      projectId,
      operation: "list_files",
      payload: {},
    })) as ProjectFileSnapshot[];

    expect(restored).toMatchObject({
      revision: 7,
      head: candidateState.head,
      files: [],
    });
    expect(restoredFiles).toEqual([
      expect.objectContaining(files[0]),
      expect.objectContaining(files[1]),
    ]);
  });

  it("does not overwrite an existing target repository with a different HEAD", async () => {
    const candidateId = `migration-${randomUUID()}`;
    const projectId = randomUUID();
    const candidate = new BrowserGitRuntime(candidateId, { wipe: true });
    const target = new BrowserGitRuntime(projectId, { wipe: true });
    const files = [{ path: "README.md", content: "# Candidate\n" }];
    const manifestHash = await manifestHashFor(files);
    const candidateState = await candidate.initializeMigrationCandidate({
      projectName: "Candidate",
      sourceRevision: 1,
      manifestHash,
      initialFiles: files,
    });

    await target.execute({
      protocol: "webpilot.browser-git.v1",
      type: "request",
      requestId: randomUUID(),
      projectId,
      operation: "initialize",
      payload: {
        projectId,
        projectName: "Existing",
        initialFiles: [{ path: "README.md", content: "# Existing\n" }],
        allowCreate: true,
      },
    });

    await expect(
      candidate.promoteMigrationCandidate(
        {
          targetProjectId: projectId,
          projectName: "Candidate",
          sourceRevision: 1,
          manifestHash,
          head: candidateState.head,
        },
        () => target,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(
        /INVALID_REQUEST|PROJECT_PATH_CONFLICT/,
      ),
    });

    await expect(
      target.execute({
        protocol: "webpilot.browser-git.v1",
        type: "request",
        requestId: randomUUID(),
        projectId,
        operation: "read_file",
        payload: { path: "README.md" },
      }),
    ).resolves.toMatchObject({ content: "# Existing\n" });
  });
});

async function manifestHashFor(
  files: readonly { path: string; content: string }[],
) {
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: file.path,
      hash: await sha256ForTest(file.content),
    })),
  );
  const serialized = JSON.stringify(
    entries.sort((left, right) => left.path.localeCompare(right.path)),
  );
  return sha256ForTest(serialized);
}

async function sha256ForTest(content: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
