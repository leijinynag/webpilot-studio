import { describe, expect, it, vi } from "vitest";

import {
  createBrowserRepositoryToolFailure,
  executeBrowserRepositoryClientTool,
} from "@/domains/agent/browser-git-client-tools";
import type { BrowserRepositoryClientToolRequest } from "@/domains/agent/client-tools";
import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import type { BrowserGitProjectRepository } from "@/domains/project/browser-git-repository";
import { ProjectError, PROJECT_ERROR_CODES } from "@/domains/project/errors";

const requestBase = {
  runId: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
  projectId: "019f9d8f-f34b-7de8-b8cd-128e30baf19e",
  toolCallId: "tool-call-1",
  idempotencyKey: "run-1:tool-call-1",
  revision: 3,
} as const;

function createRepositoryMock() {
  return {
    listFiles: vi.fn(),
    searchText: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(),
    getGitState: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    commit: vi.fn(),
  } as unknown as BrowserGitProjectRepository;
}

describe("Browser Git client tools", () => {
  it("读取文件时保持请求 revision，并返回浏览器中的文件事实", async () => {
    const repository = createRepositoryMock();
    vi.mocked(repository.readFile).mockResolvedValue({
      path: "src/App.tsx",
      content: "export default function App() {}",
      byteLength: 32,
      hash: "file-hash",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const request: BrowserRepositoryClientToolRequest = {
      ...requestBase,
      toolName: "read_file",
      arguments: { path: "src/App.tsx" },
    };

    const result = await executeBrowserRepositoryClientTool({
      repository,
      request,
    });

    expect(repository.readFile).toHaveBeenCalledWith({
      path: "src/App.tsx",
    });
    expect(result).toMatchObject({
      ok: true,
      toolName: "read_file",
      revision: 3,
      data: {
        file: {
          path: "src/App.tsx",
          hash: "file-hash",
        },
      },
    });
  });

  it("允许直接创建新文件，并使用 Repository 返回的新 revision", async () => {
    const repository = createRepositoryMock();
    vi.mocked(repository.readFile).mockRejectedValue(
      new ProjectError(
        PROJECT_ERROR_CODES.fileNotFound,
        "项目文件不存在。",
        404,
      ),
    );
    vi.mocked(repository.writeFile).mockResolvedValue({
      revision: 4,
      changedPaths: ["src/New.tsx"],
    });
    const request: BrowserRepositoryClientToolRequest = {
      ...requestBase,
      toolName: "write_file",
      arguments: {
        path: "src/New.tsx",
        content: "export const New = true;",
        expectedRevision: 3,
      },
      readBeforeMutation: false,
    };

    const result = await executeBrowserRepositoryClientTool({
      repository,
      request,
    });

    expect(repository.writeFile).toHaveBeenCalledWith(request.arguments);
    expect(result).toMatchObject({
      ok: true,
      revision: 4,
      data: {
        operation: "create",
        changedPaths: ["src/New.tsx"],
      },
    });
  });

  it("已有文件未在同一 Run/revision 读取时拒绝覆盖", async () => {
    const repository = createRepositoryMock();
    vi.mocked(repository.readFile).mockResolvedValue({
      path: "src/App.tsx",
      content: "old",
      byteLength: 3,
      hash: "old-hash",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const request: BrowserRepositoryClientToolRequest = {
      ...requestBase,
      toolName: "write_file",
      arguments: {
        path: "src/App.tsx",
        content: "new",
        expectedRevision: 3,
      },
      readBeforeMutation: false,
    };

    const result = await executeBrowserRepositoryClientTool({
      repository,
      request,
    });

    expect(repository.writeFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      revision: 3,
      conflict: false,
      error: {
        code: AGENT_ERROR_CODES.toolReadRequired,
        details: { path: "src/App.tsx", revision: 3 },
      },
    });
  });

  it("stage 和 commit 只改变 Git 状态，不推进源码 revision", async () => {
    const repository = createRepositoryMock();
    vi.mocked(repository.stage).mockResolvedValue({
      projectId: requestBase.projectId,
      revision: 3,
      branch: "main",
      head: null,
      ahead: 0,
      behind: 0,
      files: [],
      commits: [],
      unavailable: false,
      unavailableReason: null,
    });
    vi.mocked(repository.commit).mockResolvedValue({
      oid: "commit-oid",
      state: {
        projectId: requestBase.projectId,
        revision: 3,
        branch: "main",
        head: "commit-oid",
        ahead: 0,
        behind: 0,
        files: [],
        commits: [],
        unavailable: false,
        unavailableReason: null,
      },
    });

    const stageResult = await executeBrowserRepositoryClientTool({
      repository,
      request: {
        ...requestBase,
        toolName: "git_stage",
        arguments: { paths: ["src/App.tsx"] },
      },
    });
    const commitRequest: BrowserRepositoryClientToolRequest = {
      ...requestBase,
      toolCallId: "tool-call-2",
      idempotencyKey: "run-1:tool-call-2",
      toolName: "git_commit",
      arguments: { message: "feat: update app" },
      author: {
        name: "Frozen Author",
        email: "frozen@example.com",
      },
    };
    const commitResult = await executeBrowserRepositoryClientTool({
      repository,
      request: commitRequest,
    });

    expect(stageResult).toMatchObject({ ok: true, revision: 3 });
    expect(repository.commit).toHaveBeenCalledWith({
      message: "feat: update app",
      authorName: "Frozen Author",
      authorEmail: "frozen@example.com",
    });
    expect(commitResult).toMatchObject({
      ok: true,
      revision: 3,
      data: { oid: "commit-oid", head: "commit-oid" },
    });
  });

  it("仓库不可用时生成可回传服务端的结构化失败", () => {
    const request: BrowserRepositoryClientToolRequest = {
      ...requestBase,
      toolName: "git_status",
      arguments: {},
    };

    expect(
      createBrowserRepositoryToolFailure(
        request,
        new ProjectError(
          PROJECT_ERROR_CODES.storageUnavailable,
          "当前浏览器中的仓库数据不存在。",
          409,
        ),
      ),
    ).toEqual({
      ok: false,
      toolName: "git_status",
      revision: 3,
      conflict: false,
      error: {
        code: PROJECT_ERROR_CODES.storageUnavailable,
        message: "当前浏览器中的仓库数据不存在。",
      },
    });
  });
});
