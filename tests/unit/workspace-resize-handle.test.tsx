// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampWorkspacePanelWidth,
  WorkspaceResizeHandle,
} from "@/components/workbench/workspace-resize-handle";

const STORAGE_KEY = "webpilot:workspace-layout:v1";

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1440,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 900,
    height: 900,
    left: 0,
    right: 1400,
    top: 0,
    width: 1400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("WorkspaceResizeHandle", () => {
  it("根据主内容保留宽度约束侧栏上下限", () => {
    expect(
      clampWorkspacePanelWidth({
        containerWidth: 1400,
        maxWidth: 520,
        minWidth: 300,
        requestedWidth: 680,
        reservedWidth: 727,
      }),
    ).toBe(520);
    expect(
      clampWorkspacePanelWidth({
        containerWidth: 1020,
        maxWidth: 520,
        minWidth: 300,
        requestedWidth: 420,
        reservedWidth: 727,
      }),
    ).toBe(300);
  });

  it("支持键盘微调、Shift 加速、双击复位并持久化", () => {
    render(<ResizeHarness />);

    const handle = screen.getByRole("separator", {
      name: "调整左侧对话面板宽度",
    });
    const container = handle.parentElement;

    expect(container).toHaveStyle("--workspace-agent-width: 340px");

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "348");
    expect(container).toHaveStyle("--workspace-agent-width: 348px");

    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "372");

    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}"),
    ).toEqual({
      version: 1,
      widths: {
        agent: 372,
      },
    });

    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute("aria-valuenow", "340");
    expect(container).toHaveStyle("--workspace-agent-width: 340px");
  });

  it("重新挂载时读取同版本宽度，窄屏则忽略桌面持久化值", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        widths: {
          agent: 456,
        },
      }),
    );

    const view = render(<ResizeHarness />);
    expect(
      screen.getByRole("separator", { name: "调整左侧对话面板宽度" }),
    ).toHaveAttribute("aria-valuenow", "456");
    view.unmount();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 708,
    });
    render(<ResizeHarness />);

    expect(
      screen.getByRole("separator", { name: "调整左侧对话面板宽度" }),
    ).toHaveAttribute("aria-valuenow", "340");
  });
});

function ResizeHarness() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={containerRef}>
      <WorkspaceResizeHandle
        containerRef={containerRef}
        cssVariable="--workspace-agent-width"
        defaultWidth={340}
        label="调整左侧对话面板宽度"
        maxWidth={520}
        minWidth={300}
        panel="agent"
        reservedWidth={727}
        resetLabel="双击恢复默认宽度"
      />
    </div>
  );
}
