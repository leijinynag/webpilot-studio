import { beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserGitProjectRepository } from "@/domains/project/browser-git-repository";
import type { ProjectDescription } from "@/domains/project/types";
import { getBrowserGitClient } from "@/infrastructure/browser-git/client";

vi.mock("@/infrastructure/browser-git/client", () => ({
  getBrowserGitClient: vi.fn(),
}));

const mockedGetBrowserGitClient = vi.mocked(getBrowserGitClient);

function createProject(
  overrides: Partial<ProjectDescription> = {},
): ProjectDescription {
  return {
    id: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
    name: "Browser Git template",
    storageKind: "browser_git",
    status: "creating",
    revision: 1,
    fileCount: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("BrowserGitProjectRepository initialization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockedGetBrowserGitClient.mockReturnValue({
      initialize: vi.fn().mockResolvedValue({
        projectId: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
        revision: 1,
        branch: "main",
        head: null,
        ahead: 0,
        behind: 0,
        files: [],
        commits: [],
        unavailable: false,
        unavailableReason: null,
      }),
    } as never);
  });

  it("把首次 provision claim 返回的模板传给 Browser Git Worker", async () => {
    const initialFiles = [
      { path: "package.json", content: '{"name":"claimed-template"}' },
      { path: "src/index.tsx", content: "export default function App() {}" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            allowCreate: true,
            initialFiles,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const repository = new BrowserGitProjectRepository(createProject());
    await repository.initialize([
      { path: "fallback.ts", content: "should not win" },
    ]);

    expect(mockedGetBrowserGitClient().initialize).toHaveBeenCalledWith({
      projectId: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
      projectName: "Browser Git template",
      initialFiles,
      allowCreate: true,
    });
  });

  it("恢复 ready 项目时不重新 claim，也不注入服务端模板", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = mockedGetBrowserGitClient();

    const repository = new BrowserGitProjectRepository(
      createProject({ status: "ready" }),
    );
    await repository.initialize([
      { path: "local-fallback.ts", content: "local fallback" },
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.initialize).toHaveBeenCalledWith({
      projectId: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
      projectName: "Browser Git template",
      initialFiles: [{ path: "local-fallback.ts", content: "local fallback" }],
      allowCreate: false,
    });
  });

  it("合并同一项目的并发初始化，只消费一次 provision claim", async () => {
    let resolveProvision!: (response: Response) => void;
    const provisionResponse = new Promise<Response>((resolve) => {
      resolveProvision = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(provisionResponse);
    vi.stubGlobal("fetch", fetchMock);
    const client = mockedGetBrowserGitClient();
    const firstRepository = new BrowserGitProjectRepository(createProject());
    const secondRepository = new BrowserGitProjectRepository(createProject());

    const firstInitialization = firstRepository.initialize();
    const secondInitialization = secondRepository.initialize();

    // 第二个 Repository 实例必须复用第一条完整初始化链，不能再次领取创建权。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.initialize).not.toHaveBeenCalled();

    resolveProvision(
      new Response(
        JSON.stringify({
          allowCreate: true,
          initialFiles: [],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const [firstState, secondState] = await Promise.all([
      firstInitialization,
      secondInitialization,
    ]);

    expect(client.initialize).toHaveBeenCalledTimes(1);
    expect(firstState).toBe(secondState);
  });

  it("初始化失败后释放共享 Promise，允许下一次调用重试", async () => {
    const client = mockedGetBrowserGitClient();
    vi.mocked(client.initialize)
      .mockRejectedValueOnce(new Error("Worker temporarily unavailable"))
      .mockResolvedValueOnce({
        projectId: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
        revision: 0,
        branch: "main",
        head: null,
        ahead: 0,
        behind: 0,
        files: [],
        commits: [],
        unavailable: false,
        unavailableReason: null,
      });
    const repository = new BrowserGitProjectRepository(
      createProject({ status: "ready", revision: 0, fileCount: 0 }),
    );

    await expect(repository.initialize()).rejects.toThrow(
      "Worker temporarily unavailable",
    );
    await expect(repository.initialize()).resolves.toMatchObject({
      projectId: "019f9d8f-e884-7b26-99d7-4f7dad1187f0",
      revision: 0,
    });
    expect(client.initialize).toHaveBeenCalledTimes(2);
  });
});
