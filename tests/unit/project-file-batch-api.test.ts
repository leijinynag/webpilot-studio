// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireRequestOwner: vi.fn(),
  batchMutateFiles: vi.fn(),
}));

vi.mock("@/domains/auth/request-owner", () => ({
  requireRequestOwner: mocks.requireRequestOwner,
}));

vi.mock("@/infrastructure/http/project-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/infrastructure/http/project-api")>();

  return {
    ...actual,
    getProjectRepository: () => ({
      batchMutateFiles: mocks.batchMutateFiles,
    }),
  };
});

import { POST } from "@/app/api/projects/[projectId]/files/batch/route";
import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";
import { normalizeProjectFileMutations } from "@/domains/project/file-mutations";
import type { ProjectFileMutation } from "@/domains/project/types";

const projectId = "11111111-1111-4111-8111-111111111111";

function createRequest(body: unknown) {
  return new Request(`http://localhost/api/projects/${projectId}/files/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects/[projectId]/files/batch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRequestOwner.mockResolvedValue("owner-1");
    mocks.batchMutateFiles.mockResolvedValue({
      revision: 4,
      changedPaths: ["src/new.ts", "src/old.ts"],
    });
  });

  it("传播认证后的 owner，并把 write/delete 作为一个批次提交", async () => {
    const mutations: ProjectFileMutation[] = [
      {
        type: "write",
        path: "src/new.ts",
        content: "export const value = 1;",
      },
      { type: "delete", path: "src/old.ts" },
    ];
    const response = await POST(
      createRequest({ expectedRevision: 3, mutations }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireRequestOwner).toHaveBeenCalledOnce();
    expect(mocks.batchMutateFiles).toHaveBeenCalledWith({
      ownerId: "owner-1",
      projectId,
      expectedRevision: 3,
      mutations,
    });
    await expect(response.json()).resolves.toEqual({
      result: {
        revision: 4,
        changedPaths: ["src/new.ts", "src/old.ts"],
      },
    });
  });

  it("拒绝不完整或带额外字段的 mutation 协议", async () => {
    const response = await POST(
      createRequest({
        expectedRevision: 3,
        mutations: [{ type: "write", path: "src/new.ts", extra: true }],
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.batchMutateFiles).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: PROJECT_ERROR_CODES.invalidRequest },
    });
  });

  it("将 Repository 的重复路径冲突保持为稳定错误 envelope", async () => {
    mocks.batchMutateFiles.mockImplementation(
      async (input: { mutations: readonly ProjectFileMutation[] }) => {
        normalizeProjectFileMutations(input.mutations);
        return { revision: 4, changedPaths: [] };
      },
    );
    const response = await POST(
      createRequest({
        expectedRevision: 3,
        mutations: [
          { type: "write", path: "src/same.ts", content: "first" },
          { type: "delete", path: "src/same.ts" },
        ],
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: PROJECT_ERROR_CODES.pathConflict,
        details: { path: "src/same.ts" },
      },
    });
  });

  it("CAS 冲突时返回新旧 revision，调用方可据此废弃旧 Diff", async () => {
    mocks.batchMutateFiles.mockRejectedValue(
      new ProjectError(
        PROJECT_ERROR_CODES.revisionConflict,
        "项目已被其他操作更新。",
        409,
        {
          expectedRevision: 3,
          actualRevision: 4,
        },
      ),
    );
    const response = await POST(
      createRequest({
        expectedRevision: 3,
        mutations: [{ type: "write", path: "src/new.ts", content: "next" }],
      }),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: PROJECT_ERROR_CODES.revisionConflict,
        message: "项目已被其他操作更新。",
        details: {
          expectedRevision: 3,
          actualRevision: 4,
        },
      },
    });
  });
});
