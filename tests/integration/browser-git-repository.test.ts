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
});
