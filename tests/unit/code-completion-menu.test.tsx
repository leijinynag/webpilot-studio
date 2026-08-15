// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodeCompletionMenu,
  type CodeCompletionSettings,
} from "@/components/workbench/code-completion-menu";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/infrastructure/i18n/ui", () => ({
  useUiI18n: () => ({
    t: (key: string) =>
      ({
        "workbench.codeCompletion.title": "AI 行内补全",
        "workbench.codeCompletion.automatic": "自动显示补全",
        "workbench.codeCompletion.trigger": "立即生成补全",
        "workbench.codeCompletion.status.configured": "模型已就绪",
      })[key] ?? key,
  }),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CodeCompletionMenu", () => {
  it("菜单关闭并完成焦点处理后才触发显式补全", async () => {
    const user = userEvent.setup();
    const onTrigger = vi.fn();
    const scheduledTriggers: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledTriggers.push(callback);
        return 1;
      });

    render(
      <TooltipProvider>
        <CodeCompletionMenu
          activeFile
          onTrigger={onTrigger}
          settings={createSettings()}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "AI 行内补全" }));
    const triggerItem = screen.getByRole("menuitem", {
      name: /立即生成补全/,
    });

    await user.click(triggerItem);

    expect(requestAnimationFrameSpy).toHaveBeenCalledOnce();
    // 关闭流程只安排下一帧任务，不在菜单仍持有焦点时同步启动 Monaco。
    expect(onTrigger).not.toHaveBeenCalled();
    scheduledTriggers[0]?.(0);
    expect(onTrigger).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "AI 行内补全" }),
    );
  });

  it("关闭自动补全后仍允许用户显式触发", async () => {
    const user = userEvent.setup();
    const onTrigger = vi.fn();

    render(
      <TooltipProvider>
        <CodeCompletionMenu
          activeFile
          onTrigger={onTrigger}
          settings={{
            ...createSettings(),
            automaticEnabled: false,
            preferenceEnabled: false,
          }}
        />
      </TooltipProvider>,
    );

    await user.click(screen.getByRole("button", { name: "AI 行内补全" }));

    expect(
      screen.getByRole("menuitem", { name: /立即生成补全/ }),
    ).not.toHaveAttribute("data-disabled");
  });
});

function createSettings(): CodeCompletionSettings {
  return {
    availability: "configured",
    automaticEnabled: true,
    configured: true,
    model: "deepseek-v4-flash",
    preferenceEnabled: true,
    setPreferenceEnabled: vi.fn(),
  };
}
