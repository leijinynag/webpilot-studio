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
import { WEB_CONTAINER_PHASE_LABELS } from "@/infrastructure/webcontainer/lifecycle";
import { webContainerRuntimeManager } from "@/infrastructure/webcontainer/runtime-manager";

export function WebContainerPreview({
  files,
  projectId,
}: {
  files: readonly ProjectFileSnapshot[];
  projectId: string;
}) {
  // Manager 是 React 外部状态源。useSyncExternalStore 能在并发渲染下提供一致快照，
  // 也避免把 WebContainer 的进程状态复制成多份组件本地 state。
  const snapshot = useSyncExternalStore(
    webContainerRuntimeManager.subscribe,
    webContainerRuntimeManager.getSnapshot,
    webContainerRuntimeManager.getSnapshot,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
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
    // React Strict Mode 会重复执行开发态 effect，Manager 内部负责合并为同一次启动。
    void webContainerRuntimeManager.start(projectTree, projectId).catch(() => {
      // 错误已经写入可订阅 snapshot，由页面统一展示诊断，避免产生未处理 Promise。
    });
    // 组件卸载时不 teardown：路由切换后仍应复用同一标签页内昂贵的 WebContainer 实例。
  }, [projectId, projectTree]);

  // previewUrl 只在 server-ready 后写入；二次校验 phase 可防止服务退出后继续渲染旧 iframe。
  const isReady = snapshot.phase === "ready" && snapshot.previewUrl;
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
      .start(projectTree, projectId)
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
            key={`${snapshot.previewUrl}-${frameRevision}`}
            ref={iframeRef}
            className="webcontainer-frame"
            src={snapshot.previewUrl ?? undefined}
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
        {/* Terminal 展示原始过程，Runtime 展示结构化事实，Diagnostics 聚焦可行动错误。 */}
        <div className="evidence-col runtime-console">
          <b>Terminal</b>
          <div aria-live="polite" className="runtime-terminal">
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
        </div>
        <div className="evidence-col">
          <b>Runtime</b>
          <div className="runtime-facts">
            <RuntimeFact
              label="Lifecycle"
              value={WEB_CONTAINER_PHASE_LABELS[snapshot.phase]}
            />
            <RuntimeFact
              label="Isolation"
              value={
                snapshot.crossOriginIsolated === null
                  ? "Checking"
                  : snapshot.crossOriginIsolated
                    ? "Enabled"
                    : "Blocked"
              }
            />
            <RuntimeFact
              label="Port"
              value={snapshot.port?.toString() ?? "5173"}
            />
          </div>
        </div>
        <div className="evidence-col">
          <b>Diagnostics</b>
          {snapshot.diagnostic ? (
            <div className="runtime-diagnostic">
              <span>{snapshot.diagnostic.message}</span>
              {snapshot.diagnostic.detail ? (
                <small>{snapshot.diagnostic.detail}</small>
              ) : null}
            </div>
          ) : (
            <div className="runtime-diagnostic runtime-diagnostic-ok">
              {snapshot.phase === "ready"
                ? "WebContainer、依赖安装与 dev server 均已通过。"
                : "启动诊断将在此处持续更新。"}
            </div>
          )}
        </div>
      </div>
    </>
  );
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
    <div className="test-line">
      <span>{label}</span>
      <b>{value}</b>
    </div>
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
