"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleStop, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type WebContainerProcessAdapter,
  webContainerRuntimeManager,
} from "@/infrastructure/webcontainer/runtime-manager";

type InteractiveTerminalProps = {
  active: boolean;
  projectId: string;
  runtimeReady: boolean;
};

type TerminalConnectionState =
  "loading" | "waiting" | "connecting" | "connected" | "exited" | "failed";

type XtermModule = typeof import("@xterm/xterm");
type XtermTerminal = InstanceType<XtermModule["Terminal"]>;
type FitAddonModule = typeof import("@xterm/addon-fit");
type XtermFitAddon = InstanceType<FitAddonModule["FitAddon"]>;

/**
 * 交互式终端只操作 WebContainer 内的运行镜像，不直接写 Repository。
 *
 * xterm 与 FitAddon 都依赖真实 DOM，因此只在用户首次打开终端时动态加载。
 * 这样服务端渲染不会触碰浏览器 API，普通 Code/Preview 首屏也无需下载终端实现。
 */
export function InteractiveTerminal({
  active,
  projectId,
  runtimeReady,
}: InteractiveTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const processRef = useRef<WebContainerProcessAdapter | null>(null);
  const processCleanupRef = useRef<(() => void) | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(false);
  const connectRequestRef = useRef(0);
  const runtimeReadyRef = useRef(runtimeReady);
  const connectionStateRef = useRef<TerminalConnectionState>(
    runtimeReady ? "loading" : "waiting",
  );
  const [connectionState, setConnectionState] =
    useState<TerminalConnectionState>(runtimeReady ? "loading" : "waiting");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const updateConnectionState = useCallback(
    (nextState: TerminalConnectionState) => {
      connectionStateRef.current = nextState;
      setConnectionState(nextState);
    },
    [],
  );

  const bindProcess = useCallback(
    (process: WebContainerProcessAdapter) => {
      processCleanupRef.current?.();
      processRef.current = process;

      const unsubscribeOutput = process.subscribeOutput((chunk) => {
        terminalRef.current?.write(chunk);
      });
      const unsubscribeExit = process.subscribeExit((state) => {
        if (processRef.current !== process || state.status === "running") {
          return;
        }

        processRef.current = null;
        updateConnectionState(
          webContainerRuntimeManager.isActiveProject(projectId)
            ? "exited"
            : "waiting",
        );
        if (state.status === "failed") {
          setConnectionError(state.error);
        }
      });

      processCleanupRef.current = () => {
        unsubscribeOutput();
        unsubscribeExit();
      };
    },
    [projectId, updateConnectionState],
  );

  const connectTerminal = useCallback(
    async (mode: "start" | "restart") => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      if (!terminal || !runtimeReadyRef.current) {
        updateConnectionState("waiting");
        return;
      }

      const requestId = connectRequestRef.current + 1;
      connectRequestRef.current = requestId;
      setConnectionError(null);
      updateConnectionState("connecting");
      fitTerminal(fitAddon, null);

      try {
        const process =
          mode === "restart"
            ? await webContainerRuntimeManager.restartTerminal({
                cols: terminal.cols,
                projectKey: projectId,
                rows: terminal.rows,
              })
            : await webContainerRuntimeManager.startTerminal({
                cols: terminal.cols,
                projectKey: projectId,
                rows: terminal.rows,
              });

        // 用户可能在 spawn 完成前切换项目或再次点击重启。迟到结果不得把
        // 旧项目进程重新挂到当前 xterm。
        if (
          connectRequestRef.current !== requestId ||
          !webContainerRuntimeManager.isActiveProject(projectId)
        ) {
          return;
        }

        bindProcess(process);
        process.resize(terminal.cols, terminal.rows);
        terminal.focus();
        updateConnectionState("connected");
      } catch (error) {
        if (connectRequestRef.current !== requestId) {
          return;
        }
        setConnectionError(toErrorMessage(error));
        updateConnectionState(runtimeReadyRef.current ? "failed" : "waiting");
      }
    },
    [bindProcess, projectId, updateConnectionState],
  );

  useEffect(() => {
    runtimeReadyRef.current = runtimeReady;
  }, [runtimeReady]);

  useEffect(() => {
    if (!active || !hostRef.current || terminalRef.current) {
      return;
    }

    let disposed = false;

    async function initializeTerminal() {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed || !hostRef.current) {
          return;
        }

        const fitAddon = new FitAddon();
        const terminal = new Terminal({
          allowProposedApi: false,
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "bar",
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
          fontSize: 12,
          lineHeight: 1.25,
          scrollback: 5_000,
          theme: readTerminalTheme(),
        });
        terminal.loadAddon(fitAddon);
        terminal.open(hostRef.current);
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;

        // xterm 的 onData 已经归一化键盘、粘贴和 Ctrl+C。输入仍需绑定到
        // 当前 process ref，Runtime 重建后不能继续写入已经退出的旧 shell。
        const inputDisposable = terminal.onData((data) => {
          const process = processRef.current;
          if (!process || process.getExitState().status !== "running") {
            return;
          }

          void process.input(data).catch((error: unknown) => {
            setConnectionError(toErrorMessage(error));
            updateConnectionState("failed");
          });
        });
        const resizeObserver = new ResizeObserver(() => {
          scheduleTerminalFit({
            fitAddon,
            process: processRef.current,
            resizeFrameRef,
            terminal,
          });
        });
        resizeObserver.observe(hostRef.current);

        scheduleTerminalFit({
          fitAddon,
          process: null,
          resizeFrameRef,
          terminal,
        });
        updateConnectionState(
          runtimeReadyRef.current ? "connecting" : "waiting",
        );
        if (runtimeReadyRef.current) {
          void connectTerminal("start");
        }

        return () => {
          inputDisposable.dispose();
          resizeObserver.disconnect();
        };
      } catch (error) {
        if (!disposed) {
          setConnectionError(toErrorMessage(error));
          updateConnectionState("failed");
        }
      }
    }

    let disposeBindings: (() => void) | undefined;
    void initializeTerminal().then((cleanup) => {
      if (disposed) {
        cleanup?.();
        return;
      }
      disposeBindings = cleanup;
    });

    return () => {
      disposed = true;
      disposeBindings?.();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      processCleanupRef.current?.();
      processCleanupRef.current = null;
      processRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [active, connectTerminal, updateConnectionState]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!active || !terminal) {
      return;
    }

    scheduleTerminalFit({
      fitAddon: fitAddonRef.current,
      process: processRef.current,
      resizeFrameRef,
      terminal,
    });
    terminal.focus();
  }, [active]);

  useEffect(() => {
    if (!active || !terminalRef.current) {
      return;
    }

    if (!runtimeReady) {
      // 依赖或构建配置变化会重建 Runtime，并在 Manager 中终止旧 jsh。
      // 记录重连意图，等新 dev server ready 后自动建立一条全新 shell。
      shouldReconnectRef.current = true;
      return;
    }

    if (
      processRef.current?.getExitState().status === "running" &&
      connectionStateRef.current === "connected"
    ) {
      fitTerminal(fitAddonRef.current, processRef.current);
      return;
    }

    if (
      connectionStateRef.current === "exited" &&
      !shouldReconnectRef.current
    ) {
      return;
    }

    shouldReconnectRef.current = false;
    void connectTerminal("start");
  }, [active, connectTerminal, runtimeReady]);

  function clearTerminal() {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
  }

  function interruptProcess() {
    const process = processRef.current;
    if (!process || process.getExitState().status !== "running") {
      return;
    }

    // ETX 与用户在终端按 Ctrl+C 完全等价，只中止前台命令，不杀死 jsh。
    void process.input("\u0003").catch((error: unknown) => {
      setConnectionError(toErrorMessage(error));
      updateConnectionState("failed");
    });
    terminalRef.current?.focus();
  }

  const visibleConnectionState =
    active && !runtimeReady ? "waiting" : connectionState;

  return (
    <section
      className="interactive-terminal"
      data-state={visibleConnectionState}
    >
      <header className="interactive-terminal-toolbar">
        <span aria-live="polite" className="terminal-connection-status">
          <i aria-hidden="true" />
          {terminalConnectionLabel(visibleConnectionState)}
        </span>
        <div className="interactive-terminal-actions">
          <TerminalActionButton
            disabled={visibleConnectionState !== "connected"}
            label="中止当前命令"
            onClick={interruptProcess}
          >
            <CircleStop />
          </TerminalActionButton>
          <TerminalActionButton
            disabled={!runtimeReady || visibleConnectionState === "connecting"}
            label="重启终端"
            onClick={() => {
              terminalRef.current?.reset();
              void connectTerminal("restart");
            }}
          >
            <RotateCcw />
          </TerminalActionButton>
          <TerminalActionButton label="清空终端" onClick={clearTerminal}>
            <Trash2 />
          </TerminalActionButton>
        </div>
      </header>
      <div
        aria-label="WebContainer 交互式终端"
        className="interactive-terminal-host"
        ref={hostRef}
      />
      {connectionError ? (
        <div className="interactive-terminal-error" role="status">
          {connectionError}
        </div>
      ) : null}
    </section>
  );
}

function TerminalActionButton({
  children,
  label,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          size="icon-xs"
          type="button"
          variant="ghost"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function scheduleTerminalFit(input: {
  fitAddon: XtermFitAddon | null;
  process: WebContainerProcessAdapter | null;
  resizeFrameRef: React.MutableRefObject<number | null>;
  terminal: XtermTerminal;
}) {
  if (input.resizeFrameRef.current !== null) {
    window.cancelAnimationFrame(input.resizeFrameRef.current);
  }

  input.resizeFrameRef.current = window.requestAnimationFrame(() => {
    input.resizeFrameRef.current = null;
    fitTerminal(input.fitAddon, input.process);
    input.terminal.refresh(0, Math.max(0, input.terminal.rows - 1));
  });
}

function fitTerminal(
  fitAddon: XtermFitAddon | null,
  process: WebContainerProcessAdapter | null,
) {
  if (!fitAddon) {
    return;
  }

  try {
    fitAddon.fit();
    // FitAddon 可能在隐藏容器中计算出 0。进程适配器仍会做一次最小值归一化，
    // 这里先过滤无效结果，减少无意义 resize 调用。
    const dimensions = fitAddon.proposeDimensions();
    if (dimensions && dimensions.cols > 1 && dimensions.rows > 1) {
      process?.resize(dimensions.cols, dimensions.rows);
    }
  } catch {
    // 标签切换的同一帧内，容器可能仍未完成布局。ResizeObserver 会在可见后重试。
  }
}

function terminalConnectionLabel(state: TerminalConnectionState): string {
  switch (state) {
    case "loading":
      return "正在加载终端";
    case "waiting":
      return "等待 Runtime 就绪";
    case "connecting":
      return "正在连接 jsh";
    case "connected":
      return "jsh 已连接";
    case "exited":
      return "终端已退出";
    case "failed":
      return "终端连接失败";
  }
}

function readTerminalTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    background: dark ? "#050607" : "#252825",
    black: dark ? "#050607" : "#252825",
    blue: dark ? "#8ea5d2" : "#8ab4d4",
    brightBlack: dark ? "#6f7175" : "#777168",
    brightBlue: dark ? "#b0c0df" : "#a8c9df",
    brightCyan: dark ? "#9cbcc4" : "#9cc9c1",
    brightGreen: dark ? "#aab9c6" : "#9cc5b5",
    brightMagenta: dark ? "#d8a88f" : "#d6a58f",
    brightRed: dark ? "#f0aa95" : "#e9a18f",
    brightWhite: "#f1f0ed",
    brightYellow: dark ? "#e6c18d" : "#dfbf8f",
    cursor: dark ? "#d58b68" : "#d9a18b",
    cyan: dark ? "#718f99" : "#73a79d",
    foreground: dark ? "#ececea" : "#e4e8e4",
    green: dark ? "#91a9bb" : "#86ad9f",
    magenta: dark ? "#c78d72" : "#c6866c",
    red: dark ? "#e09b86" : "#d9806d",
    selectionBackground: dark ? "#d58b6838" : "#eadad144",
    white: dark ? "#d3d3d0" : "#cfd5cf",
    yellow: dark ? "#d7ad75" : "#c9a46f",
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "终端操作失败，请重试。";
}
