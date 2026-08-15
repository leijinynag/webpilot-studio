"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  Logs,
  ExternalLink,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Smartphone,
  SquareTerminal,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  RuntimeDiffDialog,
  type RuntimeImportResult,
} from "@/components/preview/runtime-diff-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildProjectTemplate } from "@/domains/project/template";
import type {
  ProjectFileSnapshot,
  RuntimeFileDiff,
  RuntimeFileDiffEntry,
} from "@/domains/project/types";
import {
  type BrowserBridgeResponse,
  type BrowserCommand,
  type BrowserExecutionEvidence,
  type BrowserStep,
  type NetworkEvidence,
} from "@/domains/agent/browser-evidence";
import {
  BROWSER_VERIFY_TOOL_NAME,
  type BrowserVerifyResult,
} from "@/domains/agent/client-tools";
import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_PROBE_TYPE,
  RUNTIME_BRIDGE_VERSION,
  type RunPreviewResult,
  type RuntimeProbe,
  runtimeEnvelopeSchema,
} from "@/domains/agent/evidence";
import {
  clientToolRequestSchema,
  isPreviewClientToolRequest,
  type PreviewClientToolRequest,
  type PreviewClientToolResult,
} from "@/domains/agent/client-tools";
import { BrowserBridgeController } from "@/infrastructure/webcontainer/browser-bridge-controller";
import { PreviewEvidenceCollector } from "@/infrastructure/webcontainer/evidence-collector";
import { WEB_CONTAINER_PHASE_LABELS } from "@/infrastructure/webcontainer/lifecycle";
import { injectRuntimeBridge } from "@/infrastructure/webcontainer/runtime-bridge";
import { InteractiveTerminal } from "@/components/preview/interactive-terminal";
import {
  type WebContainerRuntimeAsset,
  webContainerRuntimeManager,
} from "@/infrastructure/webcontainer/runtime-manager";

type WebContainerPreviewProps = {
  clientToolRequest?: PreviewClientToolRequest | null;
  files: readonly ProjectFileSnapshot[];
  onClientToolResult?: (
    request: PreviewClientToolRequest,
    result: PreviewClientToolResult,
  ) =>
    | "accepted"
    | "duplicate"
    | "ignored"
    | Promise<"accepted" | "duplicate" | "ignored">;
  dirtyPaths: readonly string[];
  onImportRuntimeChanges?: (
    diff: RuntimeFileDiff,
    selectedEntries: readonly RuntimeFileDiffEntry[],
  ) => Promise<RuntimeImportResult>;
  projectId: string;
  revision: number;
};

export function WebContainerPreview(props: WebContainerPreviewProps) {
  // 一个项目拥有一份独立的预览交互状态。projectId 改变时强制重建内部实例，
  // 这样“用户曾为旧项目点击运行”不会变成新项目或返回旧项目时的隐式安装授权。
  return <ProjectWebContainerPreview key={props.projectId} {...props} />;
}

function ProjectWebContainerPreview({
  clientToolRequest,
  dirtyPaths,
  files,
  onImportRuntimeChanges,
  onClientToolResult,
  projectId,
  revision,
}: WebContainerPreviewProps) {
  // Manager 是 React 外部状态源。useSyncExternalStore 能在并发渲染下提供一致快照，
  // 也避免把 WebContainer 的进程状态复制成多份组件本地 state。
  const snapshot = useSyncExternalStore(
    webContainerRuntimeManager.subscribe,
    webContainerRuntimeManager.getSnapshot,
    webContainerRuntimeManager.getSnapshot,
  );
  const runtimeBelongsToProject =
    webContainerRuntimeManager.isActiveProject(projectId);
  // Manager 是标签页级单例，切换项目时 React 可能先渲染一帧旧项目快照。
  // 页面只展示当前项目真正拥有的状态，避免把上一项目的 URL、日志或失败诊断带进来。
  const visibleSnapshot = runtimeBelongsToProject
    ? snapshot
    : {
        ...snapshot,
        phase: "idle" as const,
        previewUrl: null,
        port: null,
        diagnostic: null,
        logs: [],
        syncedRevision: null,
      };
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const evidenceCollectorRef = useRef<PreviewEvidenceCollector | null>(null);
  const frameLoadStateRef = useRef<{
    executionKey: string | null;
    loadCount: number;
  }>({
    executionKey: null,
    loadCount: 0,
  });
  const browserBridgeControllerRef = useRef(new BrowserBridgeController());
  const submittedToolCallIdsRef = useRef(new Set<string>());
  const executingToolCallIdsRef = useRef(new Set<string>());
  const retryTimerIdsRef = useRef(new Map<string, number>());
  const [frameRevision, setFrameRevision] = useState(0);
  const [compactViewport, setCompactViewport] = useState(false);
  const [runtimePanel, setRuntimePanel] = useState<"logs" | "terminal">(
    "logs",
  );
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [clientToolRetryNonce, setClientToolRetryNonce] = useState(0);
  const [runtimeRequested, setRuntimeRequested] = useState(() =>
    webContainerRuntimeManager.isActiveProject(projectId),
  );
  const [runtimeAssets, setRuntimeAssets] = useState<
    WebContainerRuntimeAsset[]
  >([]);
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null);
  const [runtimeDiffOpen, setRuntimeDiffOpen] = useState(false);
  const [runtimeDiff, setRuntimeDiff] = useState<RuntimeFileDiff | null>(null);
  const [runtimeDiffLoading, setRuntimeDiffLoading] = useState(false);
  const [runtimeDiffError, setRuntimeDiffError] = useState<string | null>(null);
  const runtimeDiffRequestRef = useRef(0);
  const projectTree = useMemo(
    () =>
      buildProjectTemplate(
        files.map((file) => ({ path: file.path, content: file.content })),
      ),
    [files],
  );
  const projectTreeRef = useRef(projectTree);
  const onClientToolResultRef = useRef(onClientToolResult);
  const clientToolRequestRef = useRef(clientToolRequest);
  const previewUrlRef = useRef<string | null>(snapshot.previewUrl);
  const clientToolExecutionKey = createClientToolExecutionKey(
    clientToolRequest,
    projectId,
    revision,
  );
  const activeClientToolExecutionKeyRef = useRef(clientToolExecutionKey);

  useEffect(() => {
    // 这些 ref 只服务于已经启动的异步工具执行，不参与当前渲染结果。
    // 在 commit 后同步最新值，既满足 React 的纯渲染约束，也让旧执行器能在
    // 下一段异步步骤前识别 project/revision/toolCall 已经发生变化。
    projectTreeRef.current = projectTree;
    onClientToolResultRef.current = onClientToolResult;
    clientToolRequestRef.current = clientToolRequest;
    previewUrlRef.current = snapshot.previewUrl;
    activeClientToolExecutionKeyRef.current = clientToolExecutionKey;
  }, [
    clientToolRequest,
    clientToolExecutionKey,
    onClientToolResult,
    projectTree,
    snapshot.previewUrl,
  ]);

  useEffect(() => {
    // 进入工作台只切换 Runtime 的项目上下文，不触发 boot/install。若当前标签页
    // 正在持有另一个项目的容器，Manager 会先释放它，防止展示跨项目旧预览。
    webContainerRuntimeManager.activateProject(projectId);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadRuntimeAssets() {
      try {
        const response = await fetch(`/api/projects/${projectId}/assets`, {
          cache: "no-store",
        });
        const body = (await response.json().catch(() => ({}))) as {
          assets?: Array<
            WebContainerRuntimeAsset & {
              downloadUrl?: string;
            }
          >;
          error?: { message?: string };
        };

        if (!response.ok || !body.assets) {
          throw new Error(body.error?.message ?? "项目资产列表加载失败。");
        }

        if (!cancelled) {
          setRuntimeAssets(
            body.assets.filter(
              (
                asset,
              ): asset is WebContainerRuntimeAsset & {
                downloadUrl: string;
              } => typeof asset.downloadUrl === "string",
            ),
          );
          setAssetLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeAssets([]);
          setAssetLoadError(
            error instanceof Error
              ? error.message
              : "项目资产列表加载失败，请刷新后重试。",
          );
        }
      }
    }

    void loadRuntimeAssets();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (
      clientToolExecutionKey ||
      !runtimeRequested ||
      projectTreeIsEmpty(projectTree)
    ) {
      return;
    }

    evidenceCollectorRef.current = null;
    // 用户显式启动后，Repository revision 变化继续走增量同步；只有依赖清单或
    // 构建配置改变时 Manager 才重建运行镜像。Strict Mode 的重复 effect 会被合并。
    void webContainerRuntimeManager
      .start(
        projectTree,
        projectId,
        revision,
        `repository:${projectId}:${revision}`,
        runtimeAssets,
      )
      .catch(() => {
        // 错误已经写入可订阅 snapshot，由页面统一展示诊断，避免产生未处理 Promise。
      });
    // 组件卸载时不 teardown：路由切换后仍应复用同一标签页内昂贵的 WebContainer 实例。
  }, [
    clientToolExecutionKey,
    projectId,
    projectTree,
    revision,
    runtimeAssets,
    runtimeRequested,
  ]);

  useEffect(() => {
    const requestResult = clientToolRequestSchema.safeParse(clientToolRequest);
    if (
      !requestResult.success ||
      !isPreviewClientToolRequest(requestResult.data) ||
      !clientToolExecutionKey ||
      requestResult.data.projectId !== projectId ||
      requestResult.data.revision !== revision ||
      submittedToolCallIdsRef.current.has(requestResult.data.toolCallId) ||
      executingToolCallIdsRef.current.has(clientToolExecutionKey)
    ) {
      return;
    }

    const request = requestResult.data;
    const executionKey = clientToolExecutionKey;
    executingToolCallIdsRef.current.add(executionKey);
    // iframe load 事实必须绑定本次 Tool Call。否则上一次普通 Preview 的 load
    // 事件会让本次 Agent 验证误以为已经加载了注入 Runtime Bridge 的文档。
    frameLoadStateRef.current = {
      executionKey,
      loadCount: 0,
    };
    const collector = new PreviewEvidenceCollector(request.revision);
    // 同一 revision 的 Repository 快照可能因 reconcile 产生新的对象引用。
    // 执行开始时冻结当前文件树，后续普通 rerender 不得取消并重建同一个浏览器动作。
    const instrumentedTree = injectRuntimeBridge(projectTreeRef.current, {
      runId: request.runId,
      revision: request.revision,
    });
    evidenceCollectorRef.current = collector;

    function isStaleExecution(): boolean {
      return activeClientToolExecutionKeyRef.current !== executionKey;
    }

    function scheduleRetry() {
      if (
        isStaleExecution() ||
        submittedToolCallIdsRef.current.has(request.toolCallId) ||
        retryTimerIdsRef.current.has(executionKey)
      ) {
        return;
      }

      // ignored 常见于客户端结果比挂起事务更早抵达，网络失败也可能只是瞬时故障。
      // 保持 Bridge 运行镜像不变，短暂退避后用同一幂等键重新执行并提交。
      const timerId = window.setTimeout(() => {
        retryTimerIdsRef.current.delete(executionKey);
        if (
          activeClientToolExecutionKeyRef.current === executionKey &&
          !submittedToolCallIdsRef.current.has(request.toolCallId)
        ) {
          setClientToolRetryNonce((current) => current + 1);
        }
      }, 1_200);
      retryTimerIdsRef.current.set(executionKey, timerId);
    }

    function sendBrowserCommand(input: {
      command: BrowserCommand;
      iframe: HTMLIFrameElement;
      previewUrl: string;
      sessionId: string;
      timeoutMs?: number;
    }) {
      return browserBridgeControllerRef.current.request({
        ...input,
        revision: request.revision,
        runId: request.runId,
      });
    }

    async function executeClientTool() {
      // 从真正开始执行客户端副作用时计时。请求可能已经在数据库等待了很久，
      // 但页面未打开、会话未选中等自然等待不属于安装与预览性能。
      const executionStartedAt = Date.now();
      let browserResult: BrowserExecutionEvidence | null = null;
      let networkResult: NetworkEvidence | null = null;
      let browserSessionStarted = false;
      const browserSessionId =
        request.toolName === BROWSER_VERIFY_TOOL_NAME
          ? request.verificationRunId
          : null;

      try {
        await webContainerRuntimeManager.start(
          instrumentedTree,
          projectId,
          request.revision,
          `agent:${request.runId}:${request.toolCallId}:${request.revision}`,
          runtimeAssets,
        );

        if (isStaleExecution()) {
          return;
        }

        // 普通 Preview 可能在 Bridge 注入前已经加载了同一个 URL。仅写回 index.html
        // 不保证 dev server 会刷新当前文档，因此显式重建 iframe 读取注入后的页面。
        setFrameRevision((current) => current + 1);

        // 首次 RENDER_OK 可能早于父页面 effect 完成注册。观察窗口内主动发送
        // 严格绑定当前 Run/revision 的 probe，Bridge 会定向回传首帧事实。
        await waitForRuntimeRender({
          collector,
          request,
          iframeRef,
          hasFrameLoaded: () =>
            frameLoadStateRef.current.executionKey === executionKey &&
            frameLoadStateRef.current.loadCount > 0,
          reloadFrame: () => {
            setFrameRevision((current) => current + 1);
          },
          timeoutMs: 15_000,
        });

        if (isStaleExecution()) {
          return;
        }

        if (request.toolName === BROWSER_VERIFY_TOOL_NAME && browserSessionId) {
          const previewUrl =
            webContainerRuntimeManager.getSnapshot().previewUrl;
          if (!previewUrl || !iframeRef.current) {
            throw new Error("Preview 尚未就绪，无法执行浏览器冒烟步骤。");
          }

          await requireSuccessfulBrowserResponse(
            await sendBrowserCommand({
              command: { name: "start_session" },
              iframe: iframeRef.current,
              previewUrl,
              sessionId: browserSessionId,
            }),
          );
          browserSessionStarted = true;

          // scan_dom 会建立仅在本次 session 内有效的 scan id，同时为动作失败时
          // 的 DOM context 提供同一套目标语义。计划若只使用 test id/CSS 也安全。
          await requireSuccessfulBrowserResponse(
            await sendBrowserCommand({
              command: { name: "scan_dom" },
              iframe: iframeRef.current,
              previewUrl,
              sessionId: browserSessionId,
            }),
          );
          const execution = await sendBrowserCommand({
            command: {
              name: "execute_steps",
              steps: request.arguments.steps,
            },
            iframe: iframeRef.current,
            previewUrl,
            sessionId: browserSessionId,
            timeoutMs: browserCommandTimeout(request.arguments.steps),
          });
          requireSuccessfulBrowserResponse(execution);
          if (execution.commandName !== "execute_steps") {
            throw new Error("Browser Bridge 返回了错误的步骤执行响应。");
          }
          browserResult = execution.result;

          await delay(request.arguments.observationMs);
          const network = await sendBrowserCommand({
            command: { name: "get_network", includeSuccessful: false },
            iframe: iframeRef.current,
            previewUrl,
            sessionId: browserSessionId,
          });
          requireSuccessfulBrowserResponse(network);
          if (network.commandName !== "get_network") {
            throw new Error("Browser Bridge 返回了错误的网络证据响应。");
          }
          networkResult = network.result;
        } else {
          await delay(request.arguments.observationMs);
        }

        if (isStaleExecution()) {
          return;
        }

        const previewResult = collector.finish(
          webContainerRuntimeManager.getSnapshot(),
          Date.now() - executionStartedAt,
        );
        await submitResult(
          request.toolName === BROWSER_VERIFY_TOOL_NAME
            ? createBrowserVerifyResult({
                browser:
                  browserResult ??
                  createBrowserBridgeFailure(
                    request.revision,
                    browserSessionId ?? request.verificationRunId,
                    request.arguments.steps[0]?.action ?? "assert_visible",
                    "Browser Bridge 没有返回步骤执行结果。",
                  ),
                network:
                  networkResult ??
                  createEmptyNetworkEvidence(
                    request.revision,
                    browserSessionId ?? request.verificationRunId,
                  ),
                preview: previewResult,
                request,
              })
            : previewResult,
        );
      } catch (error) {
        if (!isStaleExecution()) {
          // 安装、构建或 dev server 失败已经进入 Manager snapshot。
          // 即使没有 iframe 消息，也必须返回结构化 BuildEvidence 给 Agent。
          const previewResult = collector.finish(
            webContainerRuntimeManager.getSnapshot(),
            Date.now() - executionStartedAt,
          );
          await submitResult(
            request.toolName === BROWSER_VERIFY_TOOL_NAME
              ? createBrowserVerifyResult({
                  browser:
                    browserResult ??
                    createBrowserBridgeFailure(
                      request.revision,
                      browserSessionId ?? request.verificationRunId,
                      request.arguments.steps[0]?.action ?? "assert_visible",
                      error instanceof Error
                        ? error.message
                        : "浏览器冒烟执行失败。",
                    ),
                  network:
                    networkResult ??
                    createEmptyNetworkEvidence(
                      request.revision,
                      browserSessionId ?? request.verificationRunId,
                    ),
                  preview: previewResult,
                  request,
                })
              : previewResult,
          );
        }
      } finally {
        if (
          browserSessionStarted &&
          browserSessionId &&
          iframeRef.current &&
          webContainerRuntimeManager.getSnapshot().previewUrl
        ) {
          try {
            await sendBrowserCommand({
              command: { name: "end_session" },
              iframe: iframeRef.current,
              previewUrl:
                webContainerRuntimeManager.getSnapshot().previewUrl ?? "",
              sessionId: browserSessionId,
            });
          } catch {
            // 证据已经在 end_session 前读取。结束命令失败只意味着 iframe 将随
            // 下一次重建清理，不能覆盖已经完成的验证结果。
          }
        }
        executingToolCallIdsRef.current.delete(executionKey);
        if (frameLoadStateRef.current.executionKey === executionKey) {
          frameLoadStateRef.current = {
            executionKey: null,
            loadCount: 0,
          };
        }
        if (evidenceCollectorRef.current === collector) {
          evidenceCollectorRef.current = null;
        }
      }
    }

    async function submitResult(result: PreviewClientToolResult) {
      if (
        isStaleExecution() ||
        submittedToolCallIdsRef.current.has(request.toolCallId)
      ) {
        return;
      }

      try {
        const disposition = await onClientToolResultRef.current?.(
          request,
          result,
        );

        // accepted/duplicate 表示服务端已经保存这份幂等结果，后续快照重建时
        // 不应重复执行浏览器动作。ignored 可能只是 Run 挂起事务尚未可见；
        // 此时不能永久封存 toolCallId，恢复等待态后仍需允许同一请求重试。
        if (disposition === "ignored") {
          scheduleRetry();
        } else {
          submittedToolCallIdsRef.current.add(request.toolCallId);
        }
      } catch {
        // 网络失败时保留请求为 pending，允许后续 effect/刷新使用相同幂等键重试。
        submittedToolCallIdsRef.current.delete(request.toolCallId);
        scheduleRetry();
      }
    }

    void executeClientTool();
  }, [
    clientToolExecutionKey,
    clientToolRequest,
    clientToolRetryNonce,
    projectId,
    revision,
  ]);

  useEffect(
    () => () => {
      // 卸载后所有在途异步步骤都应视为 stale，不能再向已离开的工作台提交证据。
      activeClientToolExecutionKeyRef.current = null;
      for (const timerId of retryTimerIdsRef.current.values()) {
        window.clearTimeout(timerId);
      }
      retryTimerIdsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const controller = browserBridgeControllerRef.current;
    return () => controller.dispose();
  }, []);

  useEffect(() => {
    function recordDiagnostic(
      code:
        | "invalid_source"
        | "invalid_origin"
        | "invalid_envelope"
        | "unknown_run"
        | "stale_revision"
        | "frame_load_timeout"
        | "bridge_unresponsive",
      message: string,
    ) {
      evidenceCollectorRef.current?.addDiagnostic({
        code,
        message,
        timestamp: Date.now(),
      });
    }

    function handleRuntimeMessage(event: MessageEvent<unknown>) {
      if (browserBridgeControllerRef.current.handleMessage(event)) {
        return;
      }

      const collector = evidenceCollectorRef.current;
      const requestResult = clientToolRequestSchema.safeParse(
        clientToolRequestRef.current,
      );
      if (
        !collector ||
        !requestResult.success ||
        !isPreviewClientToolRequest(requestResult.data)
      ) {
        return;
      }

      const rawEnvelope =
        event.data !== null && typeof event.data === "object"
          ? (event.data as Record<string, unknown>)
          : null;
      if (rawEnvelope?.channel !== "webpilot-preview-runtime") {
        return;
      }

      if (event.source !== iframeRef.current?.contentWindow) {
        recordDiagnostic(
          "invalid_source",
          "忽略了不是来自当前 Preview iframe 的 Runtime 消息。",
        );
        return;
      }

      const expectedOrigin = previewUrlRef.current
        ? new URL(previewUrlRef.current).origin
        : null;
      if (!expectedOrigin || event.origin !== expectedOrigin) {
        recordDiagnostic(
          "invalid_origin",
          "忽略了 origin 与当前 Preview URL 不一致的 Runtime 消息。",
        );
        return;
      }

      const envelopeResult = runtimeEnvelopeSchema.safeParse(event.data);
      if (!envelopeResult.success) {
        recordDiagnostic(
          "invalid_envelope",
          "忽略了版本、类型或 payload 不符合严格协议的 Runtime 消息。",
        );
        return;
      }

      const request = requestResult.data;
      if (envelopeResult.data.runId !== request.runId) {
        recordDiagnostic(
          "unknown_run",
          "忽略了来自其他 Agent Run 的 Runtime 消息。",
        );
        return;
      }

      if (envelopeResult.data.revision !== request.revision) {
        recordDiagnostic(
          "stale_revision",
          "忽略了与当前验证 revision 不一致的 Runtime 消息。",
        );
        return;
      }

      collector.addEnvelope(envelopeResult.data);
    }

    window.addEventListener("message", handleRuntimeMessage);
    return () => window.removeEventListener("message", handleRuntimeMessage);
  }, []);

  // previewUrl 只在 server-ready 后写入；二次校验 phase 可防止服务退出后继续渲染旧 iframe。
  const isReady =
    visibleSnapshot.phase === "ready" && visibleSnapshot.previewUrl;
  const frameUrl = useMemo(
    () =>
      visibleSnapshot.previewUrl
        ? createPreviewFrameUrl(
            visibleSnapshot.previewUrl,
            frameRevision,
            clientToolRequest?.toolCallId ?? null,
          )
        : null,
    [clientToolRequest?.toolCallId, frameRevision, visibleSnapshot.previewUrl],
  );
  // 保留足够多的上下文供用户定位安装或编译失败，容器本身负责滚动，
  // 避免只显示堆栈尾部而丢失真正的首条错误信息。
  const visibleLogs = visibleSnapshot.logs.slice(-60);
  const canScanRuntimeChanges =
    runtimeBelongsToProject &&
    visibleSnapshot.phase === "ready" &&
    visibleSnapshot.syncedRevision === revision &&
    !clientToolExecutionKey &&
    Boolean(onImportRuntimeChanges);

  function refreshPreview() {
    if (!visibleSnapshot.previewUrl) {
      return;
    }

    // 刷新只重建 iframe，不重启容器、重装依赖或中断 dev server。
    // revision 进入 key 后，React 会创建新的浏览上下文并重新请求当前预览 URL。
    setFrameRevision((revision) => revision + 1);
  }

  function retryRuntime() {
    // Manager 会在可用时复用已 boot 的实例，仅重新执行失败后的项目启动链。
    void webContainerRuntimeManager
      .start(
        projectTree,
        projectId,
        revision,
        `repository:${projectId}:${revision}`,
        runtimeAssets,
      )
      .catch(() => undefined);
  }

  function startRuntime() {
    if (projectTreeIsEmpty(projectTree)) {
      return;
    }

    // 启动副作用统一由 runtimeRequested effect 执行，避免点击处理器与 effect
    // 在同一轮状态更新中各调用一次 start。Manager 虽可去重，但组件不应制造重复请求。
    setRuntimeRequested(true);
  }

  async function scanRuntimeChanges() {
    if (!canScanRuntimeChanges) {
      setRuntimeDiffOpen(true);
      setRuntimeDiffError("运行环境尚未同步到当前 Repository revision。");
      return;
    }

    const requestId = runtimeDiffRequestRef.current + 1;
    runtimeDiffRequestRef.current = requestId;
    const expectedProjectId = projectId;
    const expectedRevision = revision;
    setRuntimeDiffOpen(true);
    setRuntimeDiffLoading(true);
    setRuntimeDiffError(null);

    try {
      const diff = await webContainerRuntimeManager.detectRuntimeChanges({
        projectKey: projectId,
      });

      // 扫描可能排在 Repository 同步之后执行。结果回到 React 前必须再次校验
      // 项目与 revision 身份，陈旧 Diff 只能提示重扫，不能进入导入确认。
      const latestSnapshot = webContainerRuntimeManager.getSnapshot();
      if (
        runtimeDiffRequestRef.current !== requestId ||
        expectedProjectId !== projectId ||
        expectedRevision !== revision ||
        diff.projectKey !== expectedProjectId ||
        diff.baseRevision !== expectedRevision ||
        latestSnapshot.syncedRevision !== expectedRevision ||
        !webContainerRuntimeManager.isActiveProject(expectedProjectId)
      ) {
        setRuntimeDiff(null);
        setRuntimeDiffError("运行环境或 Repository 已变化，请重新检测。");
        return;
      }

      setRuntimeDiff(diff);
      setRuntimeDiffError(null);
    } catch (error) {
      if (runtimeDiffRequestRef.current !== requestId) {
        return;
      }

      setRuntimeDiff(null);
      setRuntimeDiffError(
        error instanceof Error
          ? error.message
          : "运行时变更检测失败，请稍后重试。",
      );
    } finally {
      if (runtimeDiffRequestRef.current === requestId) {
        setRuntimeDiffLoading(false);
      }
    }
  }

  async function importRuntimeChanges(
    diff: RuntimeFileDiff,
    selectedEntries: readonly RuntimeFileDiffEntry[],
  ): Promise<RuntimeImportResult> {
    if (
      diff.projectKey !== projectId ||
      diff.baseRevision !== revision ||
      !canScanRuntimeChanges ||
      !onImportRuntimeChanges
    ) {
      return {
        status: "stale",
        message: "Repository 或运行环境已变化，请重新检测后再导入。",
      };
    }

    return onImportRuntimeChanges(diff, selectedEntries);
  }

  const hasProjectFiles = !projectTreeIsEmpty(projectTree);

  return (
    <>
      <div className="workspace-toolbar">
        <div className="preview-tools">
          {/* M0 尚未维护 iframe 内部历史栈，先保留禁用控件以稳定后续 Browser 功能布局。 */}
          <ToolbarButton disabled label="后退">
            <ArrowLeft />
          </ToolbarButton>
          <ToolbarButton disabled label="前进">
            <ArrowRight />
          </ToolbarButton>
          <ToolbarButton
            disabled={!visibleSnapshot.previewUrl}
            label="刷新预览"
            onClick={refreshPreview}
          >
            <RefreshCw />
          </ToolbarButton>
          <ToolbarButton
            disabled={!canScanRuntimeChanges}
            label="检测运行时变更"
            onClick={scanRuntimeChanges}
          >
            <ScanSearch />
          </ToolbarButton>
        </div>

        <div className="url-bar" data-testid="preview-url">
          <span
            className={`url-status url-status-${snapshot.phase}`}
            aria-hidden="true"
          />
          <span>
            {visibleSnapshot.previewUrl ??
              `localhost:${visibleSnapshot.port ?? 5173} / waiting`}
          </span>
          <Badge variant="outline">
            {WEB_CONTAINER_PHASE_LABELS[visibleSnapshot.phase]}
          </Badge>
        </div>

        <div className="preview-tools">
          <ToolbarButton
            aria-pressed={compactViewport}
            data-testid="preview-viewport-toggle"
            label={compactViewport ? "使用桌面视口" : "使用移动视口"}
            onClick={() => setCompactViewport((current) => !current)}
          >
            {compactViewport ? <Monitor /> : <Smartphone />}
          </ToolbarButton>
          {visibleSnapshot.previewUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  aria-label="在新窗口打开预览"
                  size="icon-sm"
                  variant="ghost"
                >
                  <a
                    href={visibleSnapshot.previewUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>在新窗口打开预览</TooltipContent>
            </Tooltip>
          ) : (
            <ToolbarButton disabled label="在新窗口打开预览">
              <ExternalLink />
            </ToolbarButton>
          )}
        </div>
      </div>

      <div
        className={`preview-stage ${
          compactViewport ? "preview-stage-compact" : ""
        }`}
        data-testid="preview-stage"
      >
        {/* 移动模式只约束预览画布宽度，不修改项目代码，也不伪造浏览器 UA。 */}
        {isReady && runtimeBelongsToProject ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            key={frameUrl}
            ref={iframeRef}
            className="webcontainer-frame"
            onLoad={() => {
              const requestResult = clientToolRequestSchema.safeParse(
                clientToolRequestRef.current,
              );
              if (
                requestResult.success &&
                isPreviewClientToolRequest(requestResult.data)
              ) {
                const executionKey = createClientToolExecutionKey(
                  requestResult.data,
                  projectId,
                  revision,
                );
                if (
                  executionKey &&
                  frameLoadStateRef.current.executionKey === executionKey
                ) {
                  frameLoadStateRef.current.loadCount += 1;
                }
                postRuntimeProbe(
                  iframeRef.current,
                  previewUrlRef.current,
                  requestResult.data,
                );
              }
            }}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            src={frameUrl ?? undefined}
            title="WebContainer 项目预览"
          />
        ) : (
          <RuntimePlaceholder
            diagnostic={visibleSnapshot.diagnostic}
            hasProjectFiles={hasProjectFiles}
            onStart={startRuntime}
            onRetry={retryRuntime}
            phase={visibleSnapshot.phase}
          />
        )}
      </div>

      <div className="evidence-drawer">
        <header className="evidence-heading">
          <div
            aria-label="Runtime 输出视图"
            className="runtime-view-tabs"
            role="tablist"
          >
            <button
              aria-selected={runtimePanel === "logs"}
              className={runtimePanel === "logs" ? "is-active" : undefined}
              onClick={() => setRuntimePanel("logs")}
              role="tab"
              type="button"
            >
              <Logs />
              日志
            </button>
            <button
              aria-selected={runtimePanel === "terminal"}
              className={
                runtimePanel === "terminal" ? "is-active" : undefined
              }
              onClick={() => {
                setTerminalOpened(true);
                setRuntimePanel("terminal");
              }}
              role="tab"
              type="button"
            >
              <SquareTerminal />
              终端
            </button>
          </div>
          <div className="runtime-facts" aria-label="运行时状态">
            <RuntimeFact
              label="State"
              value={WEB_CONTAINER_PHASE_LABELS[visibleSnapshot.phase]}
            />
            <RuntimeFact
              label="Port"
              value={visibleSnapshot.port?.toString() ?? "5173"}
            />
            <RuntimeFact
              label="Revision"
              value={visibleSnapshot.syncedRevision?.toString() ?? "Pending"}
            />
          </div>
        </header>
        <div className="runtime-output">
          <div
            aria-live="polite"
            className="runtime-terminal runtime-console"
            hidden={runtimePanel !== "logs"}
            role="tabpanel"
          >
            {visibleLogs.length > 0 ? (
              visibleLogs.map((line, index) => (
                <div className="console-line" key={`${index}-${line}`}>
                  {line}
                </div>
              ))
            ) : (
              <div className="console-line">等待运行时输出...</div>
            )}
          </div>
          {terminalOpened ? (
            <div
              className="runtime-terminal-panel"
              hidden={runtimePanel !== "terminal"}
              role="tabpanel"
            >
              <InteractiveTerminal
                active={runtimePanel === "terminal"}
                projectId={projectId}
                runtimeReady={
                  runtimeBelongsToProject &&
                  visibleSnapshot.phase === "ready"
                }
              />
            </div>
          ) : null}
          {visibleSnapshot.diagnostic ? (
            <aside className="runtime-diagnostic">
              <span>{visibleSnapshot.diagnostic.message}</span>
              {visibleSnapshot.diagnostic.detail ? (
                <small>{visibleSnapshot.diagnostic.detail}</small>
              ) : null}
            </aside>
          ) : null}
          {assetLoadError ? (
            <aside className="runtime-diagnostic">
              <span>项目图片资产未能加载。</span>
              <small>{assetLoadError} 可刷新页面后重试。</small>
            </aside>
          ) : null}
        </div>
      </div>
      <RuntimeDiffDialog
        diff={runtimeDiff}
        dirtyPaths={dirtyPaths}
        errorMessage={runtimeDiffError}
        loading={runtimeDiffLoading}
        onImport={importRuntimeChanges}
        onOpenChange={(open) => {
          setRuntimeDiffOpen(open);
          if (!open) {
            setRuntimeDiffError(null);
          }
        }}
        onRescan={scanRuntimeChanges}
        open={runtimeDiffOpen}
      />
    </>
  );
}

type BrowserResponsePayload = BrowserBridgeResponse["payload"];

function createClientToolExecutionKey(
  request: PreviewClientToolRequest | null | undefined,
  projectId: string,
  revision: number,
): string | null {
  const requestResult = clientToolRequestSchema.safeParse(request);
  if (
    !requestResult.success ||
    requestResult.data.projectId !== projectId ||
    requestResult.data.revision !== revision
  ) {
    return null;
  }

  const value = requestResult.data;
  return `${value.runId}:${value.toolCallId}:${value.revision}`;
}

function requireSuccessfulBrowserResponse(
  payload: BrowserResponsePayload,
): asserts payload is Extract<BrowserResponsePayload, { ok: true }> {
  if (!payload.ok) {
    throw new Error(payload.error.message);
  }
}

function browserCommandTimeout(steps: readonly BrowserStep[]): number {
  // execute_steps 在 iframe 内串行执行。宿主 timeout 要覆盖所有步骤的独立
  // timeout，再留出消息排队余量，否则合法的长 smoke plan 会被父页面提前中断。
  const stepBudget = steps.reduce(
    (total, step) => total + (step.timeoutMs ?? 2_000),
    0,
  );
  return Math.min(110_000, Math.max(6_000, stepBudget + 2_000));
}

function createBrowserVerifyResult(input: {
  browser: BrowserExecutionEvidence;
  network: NetworkEvidence;
  preview: RunPreviewResult;
  request: Extract<PreviewClientToolRequest, { toolName: "browser_verify" }>;
}): BrowserVerifyResult {
  const assertionActions = new Set([
    "assert_text",
    "assert_visible",
    "assert_url",
  ]);
  const resultByIndex = new Map(
    input.browser.steps.map((step) => [step.index, step]),
  );
  const actions = input.request.arguments.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => !assertionActions.has(step.action))
    .every(({ index }) => resultByIndex.get(index)?.status === "passed");
  const assertions = input.request.arguments.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => assertionActions.has(step.action))
    .every(({ index }) => resultByIndex.get(index)?.status === "passed");
  const checks = {
    build:
      input.preview.build.install.status === "succeeded" &&
      input.preview.build.devServer.status === "ready" &&
      input.preview.build.errors.length === 0,
    runtime:
      input.preview.runtime.rendered &&
      !input.preview.runtime.events.some(
        (event) =>
          event.type === "RUNTIME_ERROR" ||
          event.type === "UNHANDLED_REJECTION",
      ),
    console: !input.preview.console.entries.some(
      (entry) => entry.level === "error",
    ),
    // 客户端只做即时投影；可接受网络失败匹配与 revision fence 均由服务端重算。
    network: !input.network.entries.some((entry) => entry.failed),
    actions,
    assertions,
    revision:
      input.preview.revision === input.request.revision &&
      input.browser.revision === input.request.revision &&
      input.network.revision === input.request.revision,
  };
  const ok = Object.values(checks).every(Boolean);

  return {
    ok,
    toolName: BROWSER_VERIFY_TOOL_NAME,
    verificationRunId: input.request.verificationRunId,
    revision: input.request.revision,
    replayCount: input.request.replayCount,
    durationMs: input.preview.durationMs,
    summary: ok
      ? "浏览器冒烟步骤已执行，原始证据等待服务端最终确认。"
      : "浏览器冒烟步骤存在失败，原始证据等待服务端归一化。",
    build: input.preview.build,
    runtime: input.preview.runtime,
    console: input.preview.console,
    browser: input.browser,
    network: input.network,
    acceptedNetworkFailures: input.request.arguments.acceptedNetworkFailures,
    checks,
  };
}

function createBrowserBridgeFailure(
  revision: number,
  sessionId: string,
  action: BrowserStep["action"],
  message: string,
): BrowserExecutionEvidence {
  return {
    revision,
    sessionId,
    ok: false,
    steps: [
      {
        index: 0,
        action,
        startedAt: Date.now(),
        durationMs: 0,
        target: null,
        status: "failed",
        message,
        error: {
          code: "action_failed",
          message,
        },
      },
    ],
    failedStep: 0,
    domContext: null,
  };
}

function createEmptyNetworkEvidence(
  revision: number,
  sessionId: string,
): NetworkEvidence {
  return {
    revision,
    sessionId,
    entries: [],
    totalBytes: 0,
    truncated: false,
    includesSuccessful: false,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function waitForRuntimeRender({
  collector,
  fallbackReloadAfterMs = 5_000,
  hasFrameLoaded,
  iframeRef,
  pollIntervalMs = 100,
  reloadFrame,
  request,
  timeoutMs,
}: {
  collector: PreviewEvidenceCollector;
  fallbackReloadAfterMs?: number;
  hasFrameLoaded: () => boolean;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  pollIntervalMs?: number;
  reloadFrame: () => void;
  request: PreviewClientToolRequest;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  let fallbackReloaded = false;

  while (!collector.hasRendered() && Date.now() - startedAt < timeoutMs) {
    const snapshot = webContainerRuntimeManager.getSnapshot();
    if (snapshot.phase !== "ready") {
      throw new Error(
        `Preview 在 Browser Bridge 就绪前进入 ${snapshot.phase} 状态。`,
      );
    }

    // setFrameRevision 只负责请求 React 重建 iframe，提交到 DOM 仍是异步的。
    // 持续向“当前” iframe 发送 probe，能跨过旧文档引用与新文档加载之间的短窗口；
    // 收到带 Run/revision 的 RENDER_OK 后，才允许后续动作进入页面。
    postRuntimeProbe(iframeRef.current, snapshot.previewUrl, request);

    // 首次导航需要一个连续窗口完成 HTML、模块图和 React 首帧。每秒销毁 iframe
    // 会让较慢项目永远回到加载起点，因此只在等待中段执行一次 cache-busting
    // 兜底刷新，兼顾旧 index.html 缓存与稳定首帧两种情况。
    if (!fallbackReloaded && Date.now() - startedAt >= fallbackReloadAfterMs) {
      fallbackReloaded = true;
      reloadFrame();
    }

    await delay(pollIntervalMs);
  }

  if (!collector.hasRendered()) {
    const frameLoaded = hasFrameLoaded();
    collector.addDiagnostic({
      code: frameLoaded ? "bridge_unresponsive" : "frame_load_timeout",
      message: frameLoaded
        ? "Preview iframe 已完成加载，但当前 Run/revision 的 Runtime Bridge 未返回首帧确认。"
        : "Preview iframe 在观察窗口内没有完成加载，Runtime Bridge 尚无机会返回首帧确认。",
      timestamp: Date.now(),
    });
    throw new Error(
      frameLoaded
        ? `Preview iframe 已加载，但 Runtime Bridge 在 ${timeoutMs}ms 内未确认首帧渲染。`
        : `Preview iframe 在 ${timeoutMs}ms 内未完成加载。`,
    );
  }
}

function postRuntimeProbe(
  iframe: HTMLIFrameElement | null,
  previewUrl: string | null,
  request: PreviewClientToolRequest,
): void {
  if (!iframe?.contentWindow || !previewUrl) {
    return;
  }

  try {
    const probe: RuntimeProbe = {
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId: request.runId,
      revision: request.revision,
      type: RUNTIME_BRIDGE_PROBE_TYPE,
    };
    iframe.contentWindow.postMessage(probe, new URL(previewUrl).origin);
  } catch {
    // URL 在 Manager 中已经过 server-ready 验证；若浏览器仍拒绝发送，
    // 后续 finish 会以 rendered=false 返回，而不是放宽为通配 origin。
  }
}

function createPreviewFrameUrl(
  previewUrl: string,
  frameRevision: number,
  toolCallId: string | null,
): string {
  const url = new URL(previewUrl);
  // 仅改变查询参数，不改变 origin。WebContainer/Rsbuild 会重新返回最新 index.html，
  // 避免同 URL 的内存缓存让 iframe 继续执行 Bridge 注入前的旧文档。
  url.searchParams.set(
    "__webpilot_frame",
    toolCallId ? `${toolCallId}:${frameRevision}` : String(frameRevision),
  );
  return url.toString();
}

function RuntimePlaceholder({
  diagnostic,
  hasProjectFiles,
  onStart,
  onRetry,
  phase,
}: {
  diagnostic: { message: string; detail?: string } | null;
  hasProjectFiles: boolean;
  onStart: () => void;
  onRetry: () => void;
  phase: keyof typeof WEB_CONTAINER_PHASE_LABELS;
}) {
  const failed = phase === "failed";

  return (
    <div
      aria-live="polite"
      className="runtime-placeholder"
      data-phase={phase}
      data-testid="webcontainer-runtime"
    >
      <span
        className={`runtime-orbit ${failed ? "runtime-orbit-failed" : ""}`}
        aria-hidden="true"
      />
      <p>{failed ? "Runtime diagnostic" : "Browser runtime"}</p>
      <h2>{diagnostic?.message ?? WEB_CONTAINER_PHASE_LABELS[phase]}</h2>
      <span>
        {diagnostic?.detail ??
          (phase === "idle"
            ? hasProjectFiles
              ? "代码已就绪。运行时会在你启动预览后挂载文件并安装依赖。"
              : "项目还是空的。先创建文件或告诉 Agent 要构建什么，运行环境会在需要时启动。"
            : "正在浏览器内准备 Node.js 环境、项目文件和开发服务器。")}
      </span>
      {failed ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw data-icon="inline-start" />
          重试运行时
        </Button>
      ) : phase === "idle" && hasProjectFiles ? (
        <Button size="sm" onClick={onStart}>
          <Play data-icon="inline-start" />
          运行预览
        </Button>
      ) : null}
    </div>
  );
}

function projectTreeIsEmpty(tree: ReturnType<typeof buildProjectTemplate>) {
  return Object.keys(tree).length === 0;
}

function RuntimeFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="runtime-fact">
      <span>{label}</span>
      <b>{value}</b>
    </span>
  );
}

function ToolbarButton({
  children,
  label,
  ...props
}: {
  children: React.ReactNode;
  label: string;
} & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button aria-label={label} size="icon-sm" variant="ghost" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
