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
  ExternalLink,
  Monitor,
  RefreshCw,
  RotateCcw,
  Smartphone,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildProjectTemplate } from "@/domains/project/template";
import type { ProjectFileSnapshot } from "@/domains/project/types";
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
  type ClientToolRequest,
  type ClientToolResult,
} from "@/domains/agent/client-tools";
import { BrowserBridgeController } from "@/infrastructure/webcontainer/browser-bridge-controller";
import { PreviewEvidenceCollector } from "@/infrastructure/webcontainer/evidence-collector";
import { WEB_CONTAINER_PHASE_LABELS } from "@/infrastructure/webcontainer/lifecycle";
import { injectRuntimeBridge } from "@/infrastructure/webcontainer/runtime-bridge";
import { webContainerRuntimeManager } from "@/infrastructure/webcontainer/runtime-manager";

export function WebContainerPreview({
  clientToolRequest,
  files,
  onClientToolResult,
  projectId,
  revision,
}: {
  clientToolRequest?: ClientToolRequest | null;
  files: readonly ProjectFileSnapshot[];
  onClientToolResult?: (
    request: ClientToolRequest,
    result: ClientToolResult,
  ) => void | Promise<void>;
  projectId: string;
  revision: number;
}) {
  // Manager 是 React 外部状态源。useSyncExternalStore 能在并发渲染下提供一致快照，
  // 也避免把 WebContainer 的进程状态复制成多份组件本地 state。
  const snapshot = useSyncExternalStore(
    webContainerRuntimeManager.subscribe,
    webContainerRuntimeManager.getSnapshot,
    webContainerRuntimeManager.getSnapshot,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const evidenceCollectorRef = useRef<PreviewEvidenceCollector | null>(null);
  const browserBridgeControllerRef = useRef(new BrowserBridgeController());
  const submittedToolCallIdsRef = useRef(new Set<string>());
  const [frameRevision, setFrameRevision] = useState(0);
  const [compactViewport, setCompactViewport] = useState(false);
  const projectTree = useMemo(
    () =>
      buildProjectTemplate(
        files.map((file) => ({ path: file.path, content: file.content })),
      ),
    [files],
  );

  useEffect(() => {
    if (clientToolRequest) {
      return;
    }

    evidenceCollectorRef.current = null;
    // React Strict Mode 会重复执行开发态 effect，Manager 内部负责合并为同一次启动。
    void webContainerRuntimeManager
      .start(
        projectTree,
        projectId,
        revision,
        `repository:${projectId}:${revision}`,
      )
      .catch(() => {
        // 错误已经写入可订阅 snapshot，由页面统一展示诊断，避免产生未处理 Promise。
      });
    // 组件卸载时不 teardown：路由切换后仍应复用同一标签页内昂贵的 WebContainer 实例。
  }, [clientToolRequest, projectId, projectTree, revision]);

  useEffect(() => {
    const requestResult = clientToolRequestSchema.safeParse(clientToolRequest);
    if (
      !requestResult.success ||
      requestResult.data.projectId !== projectId ||
      requestResult.data.revision !== revision ||
      submittedToolCallIdsRef.current.has(requestResult.data.toolCallId)
    ) {
      return;
    }

    const request = requestResult.data;
    const collector = new PreviewEvidenceCollector(request.revision);
    const instrumentedTree = injectRuntimeBridge(projectTree, {
      runId: request.runId,
      revision: request.revision,
    });
    let cancelled = false;
    evidenceCollectorRef.current = collector;

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
        );

        if (cancelled) {
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
          reloadFrame: () => {
            setFrameRevision((current) => current + 1);
          },
          timeoutMs: 15_000,
        });

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

        if (cancelled) {
          return;
        }

        const previewResult = collector.finish(
          webContainerRuntimeManager.getSnapshot(),
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
        if (!cancelled) {
          // 安装、构建或 dev server 失败已经进入 Manager snapshot。
          // 即使没有 iframe 消息，也必须返回结构化 BuildEvidence 给 Agent。
          const previewResult = collector.finish(
            webContainerRuntimeManager.getSnapshot(),
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
      }
    }

    async function submitResult(result: ClientToolResult) {
      if (
        cancelled ||
        submittedToolCallIdsRef.current.has(request.toolCallId)
      ) {
        return;
      }

      try {
        await onClientToolResult?.(request, result);
        submittedToolCallIdsRef.current.add(request.toolCallId);
      } catch {
        // 网络失败时保留请求为 pending，允许后续 effect/刷新使用相同幂等键重试。
        submittedToolCallIdsRef.current.delete(request.toolCallId);
      }
    }

    void executeClientTool();

    return () => {
      cancelled = true;
      if (evidenceCollectorRef.current === collector) {
        evidenceCollectorRef.current = null;
      }
    };
  }, [clientToolRequest, onClientToolResult, projectId, projectTree, revision]);

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
        | "stale_revision",
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
      const requestResult =
        clientToolRequestSchema.safeParse(clientToolRequest);
      if (!collector || !requestResult.success) {
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

      const expectedOrigin = snapshot.previewUrl
        ? new URL(snapshot.previewUrl).origin
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
  }, [clientToolRequest, snapshot.previewUrl]);

  // previewUrl 只在 server-ready 后写入；二次校验 phase 可防止服务退出后继续渲染旧 iframe。
  const isReady = snapshot.phase === "ready" && snapshot.previewUrl;
  const frameUrl = useMemo(
    () =>
      snapshot.previewUrl
        ? createPreviewFrameUrl(
            snapshot.previewUrl,
            frameRevision,
            clientToolRequest?.toolCallId ?? null,
          )
        : null,
    [clientToolRequest?.toolCallId, frameRevision, snapshot.previewUrl],
  );
  // 保留足够多的上下文供用户定位安装或编译失败，容器本身负责滚动，
  // 避免只显示堆栈尾部而丢失真正的首条错误信息。
  const visibleLogs = snapshot.logs.slice(-60);

  function refreshPreview() {
    if (!snapshot.previewUrl) {
      return;
    }

    // 刷新只重建 iframe，不重启容器、重装依赖或中断 dev server。
    // revision 进入 key 后，React 会创建新的浏览上下文并重新请求当前预览 URL。
    setFrameRevision((revision) => revision + 1);
  }

  function retryRuntime() {
    // Manager 会在可用时复用已 boot 的实例，仅重新执行失败后的项目启动链。
    void webContainerRuntimeManager
      .start(projectTree, projectId, revision)
      .catch(() => undefined);
  }

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
            disabled={!snapshot.previewUrl}
            label="刷新预览"
            onClick={refreshPreview}
          >
            <RefreshCw />
          </ToolbarButton>
        </div>

        <div className="url-bar" data-testid="preview-url">
          <span
            className={`url-status url-status-${snapshot.phase}`}
            aria-hidden="true"
          />
          <span>
            {snapshot.previewUrl ??
              `localhost:${snapshot.port ?? 5173} / waiting`}
          </span>
          <Badge variant="outline">
            {WEB_CONTAINER_PHASE_LABELS[snapshot.phase]}
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
          {snapshot.previewUrl ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  aria-label="在新窗口打开预览"
                  size="icon-sm"
                  variant="ghost"
                >
                  <a
                    href={snapshot.previewUrl}
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
        {isReady ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            key={frameUrl}
            ref={iframeRef}
            className="webcontainer-frame"
            onLoad={() => {
              const requestResult =
                clientToolRequestSchema.safeParse(clientToolRequest);
              if (requestResult.success) {
                postRuntimeProbe(
                  iframeRef.current,
                  snapshot.previewUrl,
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
            diagnostic={snapshot.diagnostic}
            phase={snapshot.phase}
            onRetry={retryRuntime}
          />
        )}
      </div>

      <div className="evidence-drawer">
        <header className="evidence-heading">
          <b>Runtime</b>
          <div className="runtime-facts" aria-label="运行时状态">
            <RuntimeFact
              label="State"
              value={WEB_CONTAINER_PHASE_LABELS[snapshot.phase]}
            />
            <RuntimeFact
              label="Port"
              value={snapshot.port?.toString() ?? "5173"}
            />
            <RuntimeFact
              label="Revision"
              value={snapshot.syncedRevision?.toString() ?? "Pending"}
            />
          </div>
        </header>
        <div className="runtime-output">
          <div aria-live="polite" className="runtime-terminal runtime-console">
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
          {snapshot.diagnostic ? (
            <aside className="runtime-diagnostic">
              <span>{snapshot.diagnostic.message}</span>
              {snapshot.diagnostic.detail ? (
                <small>{snapshot.diagnostic.detail}</small>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </>
  );
}

type BrowserResponsePayload = BrowserBridgeResponse["payload"];

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
  request: Extract<ClientToolRequest, { toolName: "browser_verify" }>;
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

async function waitForRuntimeRender({
  collector,
  iframeRef,
  reloadFrame,
  request,
  timeoutMs,
}: {
  collector: PreviewEvidenceCollector;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  reloadFrame: () => void;
  request: ClientToolRequest;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  let nextReloadAt = startedAt + 1_000;

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

    // WebContainer fs 写入完成后，Rsbuild 对 index.html 的重建仍可能晚到数百毫秒。
    // 首次 iframe 因而可能加载到 Bridge 注入前的旧 HTML。确认窗口内按固定间隔
    // 使用新 cache-busting URL 重建浏览上下文，直到当前 Run/revision 主动回执；
    // 重试只发生在任何 smoke action 之前，不会重复用户交互。
    if (Date.now() >= nextReloadAt) {
      reloadFrame();
      nextReloadAt = Date.now() + 1_000;
    }

    await delay(100);
  }

  if (!collector.hasRendered()) {
    throw new Error(
      `Preview Runtime Bridge 在 ${timeoutMs}ms 内未确认首帧渲染。`,
    );
  }
}

function postRuntimeProbe(
  iframe: HTMLIFrameElement | null,
  previewUrl: string | null,
  request: ClientToolRequest,
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
  onRetry,
  phase,
}: {
  diagnostic: { message: string; detail?: string } | null;
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
          "正在浏览器内准备 Node.js 环境、项目文件和开发服务器。"}
      </span>
      {failed ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw data-icon="inline-start" />
          重试运行时
        </Button>
      ) : null}
    </div>
  );
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
