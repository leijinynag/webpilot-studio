"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

const WORKSPACE_LAYOUT_STORAGE_KEY = "webpilot:workspace-layout:v1";
const WORKSPACE_LAYOUT_VERSION = 1;
const DESKTOP_LAYOUT_MIN_WIDTH = 901;
const KEYBOARD_RESIZE_STEP = 8;
const KEYBOARD_RESIZE_FAST_STEP = 24;

export type WorkspaceResizablePanel = "agent" | "explorer";

type WorkspaceLayoutStorage = {
  version: typeof WORKSPACE_LAYOUT_VERSION;
  widths: Partial<Record<WorkspaceResizablePanel, number>>;
};

type WorkspaceResizeHandleProps = {
  containerRef: RefObject<HTMLElement | null>;
  cssVariable: `--${string}`;
  defaultWidth: number;
  label: string;
  maxWidth: number;
  minWidth: number;
  panel: WorkspaceResizablePanel;
  reservedWidth: number;
  resetLabel: string;
};

/**
 * 工作台侧栏分隔条只在桌面布局生效。拖动过程中直接更新容器 CSS 变量，
 * 不把每一帧位置写入 React state，避免 Monaco、Preview 和 Agent 树被迫重渲染。
 */
export function WorkspaceResizeHandle({
  containerRef,
  cssVariable,
  defaultWidth,
  label,
  maxWidth,
  minWidth,
  panel,
  reservedWidth,
  resetLabel,
}: WorkspaceResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const [committedWidth, setCommittedWidth] = useState(defaultWidth);
  const currentWidthRef = useRef(defaultWidth);
  const dragStateRef = useRef<{
    pointerId: number;
    startClientX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const handle = handleRef.current;
    if (!container || !handle) {
      return;
    }

    const applyStoredWidth = () => {
      if (!isDesktopLayout()) {
        return;
      }

      const storedWidth = readWorkspaceLayoutWidth(panel);
      const nextWidth = clampWorkspacePanelWidth({
        containerWidth: container.getBoundingClientRect().width,
        maxWidth,
        minWidth,
        requestedWidth: storedWidth ?? defaultWidth,
        reservedWidth,
      });
      applyWidth(container, handle, cssVariable, nextWidth);
      currentWidthRef.current = nextWidth;
      setCommittedWidth(nextWidth);
    };

    applyStoredWidth();

    const handleWindowResize = () => {
      if (!isDesktopLayout()) {
        return;
      }

      // 浏览器尺寸变化时重新收紧上限，保证主编辑区始终保留最低可用宽度。
      const nextWidth = clampWorkspacePanelWidth({
        containerWidth: container.getBoundingClientRect().width,
        maxWidth,
        minWidth,
        requestedWidth: currentWidthRef.current,
        reservedWidth,
      });
      applyWidth(container, handle, cssVariable, nextWidth);
      currentWidthRef.current = nextWidth;
      setCommittedWidth(nextWidth);
    };

    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
      document.documentElement.classList.remove("is-workspace-resizing");
    };
  }, [
    containerRef,
    cssVariable,
    defaultWidth,
    maxWidth,
    minWidth,
    panel,
    reservedWidth,
  ]);

  function updateWidth(requestedWidth: number, persist: boolean) {
    const container = containerRef.current;
    const handle = handleRef.current;
    if (!container || !handle || !isDesktopLayout()) {
      return;
    }

    const nextWidth = clampWorkspacePanelWidth({
      containerWidth: container.getBoundingClientRect().width,
      maxWidth,
      minWidth,
      requestedWidth,
      reservedWidth,
    });
    applyWidth(container, handle, cssVariable, nextWidth);
    currentWidthRef.current = nextWidth;

    if (persist) {
      writeWorkspaceLayoutWidth(panel, nextWidth);
      // 高频 pointermove 只改 DOM；拖动结束、键盘操作或复位时才同步 React，
      // 让 aria-valuenow 在父组件后续重渲染后仍与真实宽度保持一致。
      setCommittedWidth(nextWidth);
    }
  }

  function finishDrag(
    event: ReactPointerEvent<HTMLDivElement>,
    persist: boolean,
  ) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.currentTarget.classList.remove("is-dragging");
    document.documentElement.classList.remove("is-workspace-resizing");

    if (persist) {
      writeWorkspaceLayoutWidth(panel, currentWidthRef.current);
      setCommittedWidth(currentWidthRef.current);
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !isDesktopLayout()) {
      return;
    }

    event.preventDefault();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth: currentWidthRef.current,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.classList.add("is-dragging");
    document.documentElement.classList.add("is-workspace-resizing");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    updateWidth(
      dragState.startWidth + event.clientX - dragState.startClientX,
      false,
    );
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const step = event.shiftKey
      ? KEYBOARD_RESIZE_FAST_STEP
      : KEYBOARD_RESIZE_STEP;
    updateWidth(
      currentWidthRef.current + (event.key === "ArrowRight" ? step : -step),
      true,
    );
  }

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maxWidth}
      aria-valuemin={minWidth}
      aria-valuenow={committedWidth}
      className="workspace-resize-handle"
      data-resize-panel={panel}
      onDoubleClick={() => updateWidth(defaultWidth, true)}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, true)}
      ref={handleRef}
      role="separator"
      tabIndex={0}
      title={`${label} · ${resetLabel}`}
    />
  );
}

export function clampWorkspacePanelWidth({
  containerWidth,
  maxWidth,
  minWidth,
  requestedWidth,
  reservedWidth,
}: {
  containerWidth: number;
  maxWidth: number;
  minWidth: number;
  requestedWidth: number;
  reservedWidth: number;
}): number {
  const availableMaximum = Math.floor(containerWidth - reservedWidth);
  const effectiveMaximum = Math.max(
    minWidth,
    Math.min(maxWidth, availableMaximum),
  );

  return Math.round(
    Math.min(effectiveMaximum, Math.max(minWidth, requestedWidth)),
  );
}

function applyWidth(
  container: HTMLElement,
  handle: HTMLElement,
  cssVariable: string,
  width: number,
) {
  container.style.setProperty(cssVariable, `${width}px`);
  handle.setAttribute("aria-valuenow", String(width));
}

function isDesktopLayout(): boolean {
  return window.innerWidth >= DESKTOP_LAYOUT_MIN_WIDTH;
}

function readWorkspaceLayoutWidth(
  panel: WorkspaceResizablePanel,
): number | null {
  try {
    const rawValue = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<WorkspaceLayoutStorage>;
    if (
      parsed.version !== WORKSPACE_LAYOUT_VERSION ||
      !parsed.widths ||
      typeof parsed.widths[panel] !== "number" ||
      !Number.isFinite(parsed.widths[panel])
    ) {
      return null;
    }

    return parsed.widths[panel] ?? null;
  } catch {
    // 隐私模式或损坏的本地数据不能阻断工作台，直接回退默认布局。
    return null;
  }
}

function writeWorkspaceLayoutWidth(
  panel: WorkspaceResizablePanel,
  width: number,
) {
  try {
    const currentWidths = readWorkspaceLayout();
    const nextValue: WorkspaceLayoutStorage = {
      version: WORKSPACE_LAYOUT_VERSION,
      widths: {
        ...currentWidths,
        [panel]: width,
      },
    };
    window.localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify(nextValue),
    );
  } catch {
    // localStorage 不可用时仍保留当前页面内的缩放结果，只放弃跨刷新持久化。
  }
}

function readWorkspaceLayout(): WorkspaceLayoutStorage["widths"] {
  try {
    const rawValue = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as Partial<WorkspaceLayoutStorage>;
    return parsed.version === WORKSPACE_LAYOUT_VERSION && parsed.widths
      ? parsed.widths
      : {};
  } catch {
    return {};
  }
}
