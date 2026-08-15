// @vitest-environment node

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireRequestOwner: vi.fn(),
  describe: vi.fn(),
  listFiles: vi.fn(),
  complete: vi.fn(),
  getCodeCompletionModelStatus: vi.fn(),
}));

vi.mock("@/domains/auth/request-owner", () => ({
  requireRequestOwner: mocks.requireRequestOwner,
}));

vi.mock("@/infrastructure/http/project-api", () => ({
  getProjectRepository: () => ({
    describe: mocks.describe,
    listFiles: mocks.listFiles,
  }),
}));

vi.mock("@/infrastructure/code-completion/runtime", () => ({
  createCodeCompletionRuntime: () => ({
    complete: mocks.complete,
  }),
}));

vi.mock("@/infrastructure/agent/provider-factory", () => ({
  getCodeCompletionModelStatus: mocks.getCodeCompletionModelStatus,
}));

vi.mock("@/infrastructure/http/agent-api", () => ({
  createRequestCorrelationId: () => "55555555-5555-4555-8555-555555555555",
  readAgentJsonBody: async (request: Request) => request.json(),
  agentJsonResponse: (
    body: unknown,
    correlationId: string,
    init?: ResponseInit,
  ) => {
    void correlationId;
    return NextResponse.json(body, init);
  },
  agentApiErrorResponse: (error: unknown, correlationId: string) => {
    void correlationId;
    return NextResponse.json(
      {
        error: {
          code:
            error instanceof Error && "code" in error
              ? error.code
              : "TEST_ERROR",
          message: error instanceof Error ? error.message : "test error",
        },
      },
      {
        status:
          error instanceof z.ZodError
            ? 400
            : error instanceof Error && "status" in error
              ? Number(error.status)
              : 500,
      },
    );
  },
}));

import {
  GET,
  POST,
} from "@/app/api/projects/[projectId]/code-completions/route";

const projectId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

function createBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clientRequestId: requestId,
    projectRevision: 3,
    path: "src/App.tsx",
    language: "typescript",
    position: { lineNumber: 4, column: 12 },
    prefix: "const value = ",
    suffix: "",
    trigger: "automatic",
    ...overrides,
  };
}

function createRequest(body: unknown) {
  return new Request(
    `http://localhost/api/projects/${projectId}/code-completions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function createStatusRequest() {
  return new Request(
    `http://localhost/api/projects/${projectId}/code-completions`,
  );
}

describe("POST /api/projects/[projectId]/code-completions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRequestOwner.mockResolvedValue("owner-1");
    mocks.describe.mockResolvedValue({
      id: projectId,
      storageKind: "database",
      revision: 3,
    });
    mocks.listFiles.mockResolvedValue([
      { path: "src/App.tsx", content: "const value = " },
      { path: "package.json", content: '{"dependencies":{}}' },
    ]);
    mocks.complete.mockResolvedValue({
      requestId,
      projectRevision: 3,
      insertText: "42",
      model: "deepseek-v4-flash",
      latencyMs: 24,
      firstResultLatencyMs: 18,
      cacheHit: false,
    });
    mocks.getCodeCompletionModelStatus.mockReturnValue({
      configured: true,
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
  });

  it("GET 校验项目归属且只返回公开模型状态", async () => {
    const response = await GET(createStatusRequest(), {
      params: Promise.resolve({ projectId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.describe).toHaveBeenCalledWith({
      ownerId: "owner-1",
      projectId,
    });
    expect(mocks.getCodeCompletionModelStatus).toHaveBeenCalledOnce();

    const body = await response.json();
    expect(body).toEqual({
      configured: true,
      model: "deepseek-v4-flash",
      provider: "deepseek",
    });
    expect(JSON.stringify(body)).not.toMatch(/api.?key|base.?url/i);
  });

  it("校验项目归属、revision，并把 Database 文件上下文交给运行时", async () => {
    const response = await POST(createRequest(createBody()), {
      params: Promise.resolve({ projectId }),
    });

    expect(response.status).toBe(200);
    expect(mocks.describe).toHaveBeenCalledWith({
      ownerId: "owner-1",
      projectId,
    });
    expect(mocks.listFiles).toHaveBeenCalledWith({
      ownerId: "owner-1",
      projectId,
    });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        currentProjectRevision: 3,
        sourceFiles: [
          { path: "src/App.tsx", content: "const value = " },
          { path: "package.json", content: '{"dependencies":{}}' },
        ],
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      insertText: "42",
      model: "deepseek-v4-flash",
    });
  });

  it("revision 过期时拒绝调用 Provider", async () => {
    const response = await POST(
      createRequest(createBody({ projectRevision: 2 })),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(409);
    expect(mocks.complete).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROJECT_REVISION_CONFLICT" },
    });
  });

  it("Browser Git 只使用客户端上下文，不读取服务端文件", async () => {
    mocks.describe.mockResolvedValue({
      id: projectId,
      storageKind: "browser_git",
      revision: 7,
    });
    const browserFiles = [
      { path: "src/App.tsx", content: "export const App = () => null;" },
      { path: "package.json", content: '{"name":"browser-project"}' },
    ];

    const response = await POST(
      createRequest(
        createBody({
          projectRevision: 7,
          browserContext: { files: browserFiles },
        }),
      ),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.listFiles).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFiles: browserFiles }),
    );
  });

  it("Browser Git 缺少当前文件时返回参数错误", async () => {
    mocks.describe.mockResolvedValue({
      id: projectId,
      storageKind: "browser_git",
      revision: 7,
    });

    const response = await POST(
      createRequest(
        createBody({
          projectRevision: 7,
          browserContext: {
            files: [{ path: "package.json", content: "{}" }],
          },
        }),
      ),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("非法请求体返回 400 且不触发运行时", async () => {
    const response = await POST(
      createRequest(createBody({ model: "client-controlled-model" })),
      { params: Promise.resolve({ projectId }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
