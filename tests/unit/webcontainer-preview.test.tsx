import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  waitForRuntimeRender,
  WebContainerPreview,
} from "@/components/preview/webcontainer-preview";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { PreviewClientToolRequest } from "@/domains/agent/client-tools";
import type { ProjectFileSnapshot } from "@/domains/project/types";

const {
  runtimeActivateProject,
  runtimeActiveProject,
  runtimeDetectRuntimeChanges,
  runtimeSnapshot,
  runtimeStart,
} = vi.hoisted(() => {
  const snapshot = {
    phase: "ready" as const,
    previewUrl: "https://5173-webpilot.local",
    port: 5173,
    logs: [],
    diagnostic: null,
    forwardedPreviewErrors: [],
    syncedRevision: 2,
    crossOriginIsolated: true,
  };
  return {
    runtimeActivateProject: vi.fn((projectId: string) => {
      // 与真实 Manager 一致：切换项目时先清空旧项目身份，避免新项目
      // 把旧项目的“已授权运行”状态误认为自己的启动许可。
      if (
        runtimeActiveProject.value !== null &&
        runtimeActiveProject.value !== projectId
      ) {
        runtimeActiveProject.value = null;
      }
    }),
    runtimeActiveProject: { value: null as string | null },
    runtimeDetectRuntimeChanges: vi.fn(async () => ({
      projectKey: "22222222-2222-4222-8222-222222222222",
      baseRevision: 2,
      entries: [
        {
          path: "src/index.tsx",
          status: "modified" as const,
          beforeContent: "export const title = 'before';",
          afterContent: "export const title = 'after';",
        },
      ],
    })),
    runtimeSnapshot: snapshot,
    runtimeStart: vi.fn(
      async (
        ...args: [
          tree?: unknown,
          projectId?: string,
          revision?: number,
          runtimeKey?: string,
        ]
      ) => {
        // 保留真实 Manager 的四参数签名，测试会通过 runtimeKey 判断是否发生
        // Repository/Agent 镜像切换；void 仅声明其余参数在此桩中无需解释。
        void args;
        runtimeActiveProject.value = args[1] ?? null;
        return snapshot;
      },
    ),
  };
});

vi.mock("@/infrastructure/webcontainer/runtime-manager", () => ({
  webContainerRuntimeManager: {
    subscribe: () => () => undefined,
    getSnapshot: () => runtimeSnapshot,
    activateProject: runtimeActivateProject,
    detectRuntimeChanges: runtimeDetectRuntimeChanges,
    isActiveProject: (projectId: string) =>
      runtimeActiveProject.value === projectId,
    start: runtimeStart,
  },
}));

vi.mock("@/infrastructure/webcontainer/runtime-bridge", () => ({
  injectRuntimeBridge: (tree: unknown) => tree,
}));

vi.mock("@/infrastructure/webcontainer/evidence-collector", () => ({
  PreviewEvidenceCollector: class {
    hasRendered() {
      return true;
    }

    addDiagnostic() {}

    addEnvelope() {}

    finish(_snapshot: unknown, durationMs: number) {
      return {
        ok: true,
        toolName: "run_preview",
        revision: 2,
        durationMs,
        summary: "预览成功。",
        build: {
          revision: 2,
          install: { status: "succeeded" },
          devServer: { status: "ready" },
          errors: [],
        },
        runtime: {
          revision: 2,
          rendered: true,
          events: [{ type: "RENDER_OK", timestamp: 1 }],
          diagnostics: [],
        },
        console: {
          revision: 2,
          entries: [],
          totalBytes: 0,
          truncated: false,
        },
      };
    }
  },
}));

vi.mock("@/infrastructure/webcontainer/browser-bridge-controller", () => ({
  BrowserBridgeController: class {
    dispose() {}

    handleMessage() {
      return false;
    }
  },
}));

const request: PreviewClientToolRequest = {
  runId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  toolCallId: "call-preview-1",
  toolName: "run_preview",
  idempotencyKey: "preview-key-1",
  revision: 2,
  arguments: {
    revision: 2,
    observationMs: 500,
  },
};

const originalResizeObserver = globalThis.ResizeObserver;

beforeAll(() => {
  // Radix Tooltip/Dialog 在测试环境里会访问 ResizeObserver。JSDOM 没有真实布局，
  // 这里提供一个空实现，只让弹层生命周期完整跑完，不参与任何尺寸推导。
  globalThis.ResizeObserver = class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
});

function createFiles(content: string): ProjectFileSnapshot[] {
  return [
    {
      path: "index.html",
      content: '<html><body><div id="root"></div></body></html>',
      byteLength: 47,
      hash: "hash-index",
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
    {
      path: "src/index.tsx",
      content,
      byteLength: content.length,
      hash: "hash-source",
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
  ];
}

function renderPreview({
  clientToolRequest = request,
  files,
  onClientToolResult,
}: {
  clientToolRequest?: PreviewClientToolRequest | null;
  files: ProjectFileSnapshot[];
  onClientToolResult: (
    request: PreviewClientToolRequest,
    result: Parameters<
      NonNullable<
        React.ComponentProps<typeof WebContainerPreview>["onClientToolResult"]
      >
    >[1],
  ) => Promise<"accepted" | "duplicate" | "ignored">;
}) {
  return render(
    <TooltipProvider>
      <WebContainerPreview
        clientToolRequest={clientToolRequest}
        dirtyPaths={[]}
        files={files}
        onClientToolResult={onClientToolResult}
        projectId={request.projectId}
        revision={2}
      />
    </TooltipProvider>,
  );
}

describe("WebContainerPreview 客户端工具执行", () => {
  afterEach(() => {
    // Vitest 4 不保证每个文件都自动卸载 React 树。显式 cleanup 可确保上一用例的
    // “运行预览”按钮和 effect 不会污染空项目断言。
    cleanup();
    runtimeActiveProject.value = null;
    runtimeActivateProject.mockClear();
    runtimeDetectRuntimeChanges.mockClear();
    runtimeStart.mockClear();
  });

  it("普通进入 Preview 不启动运行时，用户点击后才开始准备环境", async () => {
    const user = userEvent.setup();
    renderPreview({
      clientToolRequest: null,
      files: createFiles("export const title = 'manual';"),
      onClientToolResult: vi.fn(),
    });

    expect(runtimeStart).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "代码已就绪。运行时会在你启动预览后挂载文件并安装依赖。",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "运行预览" }));

    await waitFor(() => expect(runtimeStart).toHaveBeenCalledTimes(1));
    expect(runtimeStart.mock.calls[0]?.[3]).toBe(
      `repository:${request.projectId}:2`,
    );
  });

  it("空项目保持 idle 且不提供会触发安装的运行按钮", () => {
    renderPreview({
      clientToolRequest: null,
      files: [],
      onClientToolResult: vi.fn(),
    });

    expect(runtimeStart).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "项目还是空的。先创建文件或告诉 Agent 要构建什么，运行环境会在需要时启动。",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "运行预览" }),
    ).not.toBeInTheDocument();
  });

  it("从已运行项目切换到另一个项目时不继承启动请求", async () => {
    runtimeActiveProject.value = request.projectId;
    const otherProjectId = "99999999-9999-4999-8999-999999999999";
    const files = createFiles("export const title = 'project-switch';");
    const view = render(
      <TooltipProvider>
        <WebContainerPreview
          clientToolRequest={null}
          dirtyPaths={[]}
          files={files}
          onClientToolResult={vi.fn()}
          projectId={request.projectId}
          revision={2}
        />
      </TooltipProvider>,
    );

    // 原项目已经显式运行时，组件重建可以恢复它的运行状态。
    await waitFor(() => expect(runtimeStart).toHaveBeenCalledTimes(1));
    runtimeStart.mockClear();

    view.rerender(
      <TooltipProvider>
        <WebContainerPreview
          clientToolRequest={null}
          dirtyPaths={[]}
          files={files}
          onClientToolResult={vi.fn()}
          projectId={otherProjectId}
          revision={2}
        />
      </TooltipProvider>,
    );

    await waitFor(() =>
      expect(runtimeActivateProject).toHaveBeenCalledWith(otherProjectId),
    );
    // projectId 切换只负责清理旧上下文；没有用户点击或 Agent run_preview，
    // 新项目即使已有 package.json，也不能自动 mount/install。
    expect(
      runtimeStart.mock.calls.some(
        (call) =>
          call[1] === otherProjectId &&
          call[3] === `repository:${otherProjectId}:2`,
      ),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "运行预览" })).toBeVisible();
  });

  it("同一 Tool Call 的对象和文件树引用变化时不会重启或切回 Repository 镜像", async () => {
    const onClientToolResult = vi.fn(
      async (
        _request: PreviewClientToolRequest,
        _result: Parameters<
          NonNullable<
            React.ComponentProps<
              typeof WebContainerPreview
            >["onClientToolResult"]
          >
        >[1],
      ): Promise<"accepted"> => {
        void _request;
        void _result;
        return "accepted";
      },
    );
    const initialFiles = createFiles("export const title = 'initial';");
    const view = renderPreview({ files: initialFiles, onClientToolResult });

    await waitFor(() => {
      expect(runtimeStart).toHaveBeenCalledTimes(1);
    });
    expect(runtimeStart.mock.calls[0]?.[3]).toBe(
      `agent:${request.runId}:${request.toolCallId}:${request.revision}`,
    );

    // 模拟 Agent 快照重建出新 request 对象，同时 Repository reconcile 生成新文件树。
    // 两者语义仍属于同一个执行键，不得取消当前工具或让普通预览移除 Bridge。
    view.rerender(
      <TooltipProvider>
        <WebContainerPreview
          clientToolRequest={{ ...request }}
          dirtyPaths={[]}
          files={[...initialFiles]}
          onClientToolResult={onClientToolResult}
          projectId={request.projectId}
          revision={2}
        />
      </TooltipProvider>,
    );

    await waitFor(
      () => {
        expect(onClientToolResult).toHaveBeenCalledTimes(1);
      },
      { timeout: 2_000 },
    );
    const submittedResult = onClientToolResult.mock.calls[0]?.[1];
    expect(submittedResult?.durationMs).toEqual(expect.any(Number));
    expect(submittedResult?.durationMs).toBeGreaterThanOrEqual(0);
    expect(runtimeStart).toHaveBeenCalledTimes(1);
    expect(
      runtimeStart.mock.calls.some((call) =>
        String(call[3]).startsWith("repository:"),
      ),
    ).toBe(false);
  });

  it("服务端暂时 ignored 时保持 Agent 镜像并使用同一幂等请求重试", async () => {
    const onClientToolResult = vi
      .fn()
      .mockResolvedValueOnce("ignored")
      .mockResolvedValueOnce("accepted");

    renderPreview({
      files: createFiles("export const title = 'retry';"),
      onClientToolResult,
    });

    await waitFor(
      () => {
        expect(onClientToolResult).toHaveBeenCalledTimes(1);
      },
      { timeout: 2_000 },
    );

    // 退避期间不切回 Repository；到期后复用同一 Tool Call 再执行一次。
    await waitFor(
      () => {
        expect(onClientToolResult).toHaveBeenCalledTimes(2);
      },
      { timeout: 3_000 },
    );
    expect(runtimeStart).toHaveBeenCalledTimes(2);
    expect(
      runtimeStart.mock.calls.every(
        (call) =>
          call[3] ===
          `agent:${request.runId}:${request.toolCallId}:${request.revision}`,
      ),
    ).toBe(true);
  });

  it("运行时变更扫描后通过 Diff 审查导入选中文件", async () => {
    const user = userEvent.setup();
    runtimeActiveProject.value = request.projectId;
    const onImportRuntimeChanges = vi.fn<
      NonNullable<
        React.ComponentProps<typeof WebContainerPreview>["onImportRuntimeChanges"]
      >
    >(async () => ({
      status: "imported" as const,
      revision: 3,
    }));

    render(
      <TooltipProvider>
        <WebContainerPreview
          clientToolRequest={null}
          dirtyPaths={[]}
          files={createFiles("export const title = 'runtime';")}
          onClientToolResult={vi.fn()}
          onImportRuntimeChanges={onImportRuntimeChanges}
          projectId={request.projectId}
          revision={2}
        />
      </TooltipProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "检测运行时变更" }),
    );

    await waitFor(() =>
      expect(runtimeDetectRuntimeChanges).toHaveBeenCalledWith({
        projectKey: request.projectId,
      }),
    );
    expect(
      await screen.findByRole("button", { name: /src\/index\.tsx/ }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "导入 1 个文件" }));

    await waitFor(() => expect(onImportRuntimeChanges).toHaveBeenCalledTimes(1));
    expect(onImportRuntimeChanges.mock.calls[0]?.[0]).toMatchObject({
      baseRevision: 2,
      projectKey: request.projectId,
    });
    expect(onImportRuntimeChanges.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        path: "src/index.tsx",
        status: "modified",
      }),
    ]);
  });

  it("选中路径存在未保存草稿时阻止运行时导入", async () => {
    const user = userEvent.setup();
    runtimeActiveProject.value = request.projectId;
    const onImportRuntimeChanges = vi.fn();

    render(
      <TooltipProvider>
        <WebContainerPreview
          clientToolRequest={null}
          dirtyPaths={["src/index.tsx"]}
          files={createFiles("export const title = 'draft';")}
          onClientToolResult={vi.fn()}
          onImportRuntimeChanges={onImportRuntimeChanges}
          projectId={request.projectId}
          revision={2}
        />
      </TooltipProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "检测运行时变更" }),
    );

    expect(
      await screen.findByRole("button", { name: /src\/index\.tsx/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "导入 1 个文件" }),
    ).toBeDisabled();
    expect(onImportRuntimeChanges).not.toHaveBeenCalled();
  });
});

describe("Preview Runtime Bridge 首帧等待", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("稳定等待窗口内只执行一次兜底刷新", async () => {
    vi.useFakeTimers();
    const collector = {
      addDiagnostic: vi.fn(),
      hasRendered: vi.fn(() => false),
    } as unknown as Parameters<typeof waitForRuntimeRender>[0]["collector"];
    const reloadFrame = vi.fn();

    const waiting = waitForRuntimeRender({
      collector,
      fallbackReloadAfterMs: 20,
      hasFrameLoaded: () => true,
      iframeRef: { current: null },
      pollIntervalMs: 10,
      reloadFrame,
      request,
      timeoutMs: 50,
    });
    const rejected = expect(waiting).rejects.toThrow(
      "Preview iframe 已加载，但 Runtime Bridge",
    );

    await vi.advanceTimersByTimeAsync(60);
    await rejected;

    expect(reloadFrame).toHaveBeenCalledTimes(1);
    expect(collector.addDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "bridge_unresponsive",
      }),
    );
  });

  it("iframe 从未完成加载时返回 frame_load_timeout 诊断", async () => {
    vi.useFakeTimers();
    const collector = {
      addDiagnostic: vi.fn(),
      hasRendered: vi.fn(() => false),
    } as unknown as Parameters<typeof waitForRuntimeRender>[0]["collector"];

    const waiting = waitForRuntimeRender({
      collector,
      fallbackReloadAfterMs: 20,
      hasFrameLoaded: () => false,
      iframeRef: { current: null },
      pollIntervalMs: 10,
      reloadFrame: vi.fn(),
      request,
      timeoutMs: 50,
    });
    const rejected = expect(waiting).rejects.toThrow(
      "Preview iframe 在 50ms 内未完成加载",
    );

    await vi.advanceTimersByTimeAsync(60);
    await rejected;

    expect(collector.addDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "frame_load_timeout",
      }),
    );
  });
});
