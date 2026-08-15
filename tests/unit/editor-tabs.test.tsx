import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { EditorTabs } from "@/components/workbench/editor-tabs";

function renderEditorTabs(props: React.ComponentProps<typeof EditorTabs>) {
  return render(
    <TooltipProvider>
      <EditorTabs {...props} />
    </TooltipProvider>,
  );
}

describe("EditorTabs", () => {
  afterEach(cleanup);

  it("展示正式文件脏状态和流式文件生成状态", () => {
    renderEditorTabs({
      activeId: "run-1:tool-1",
      onClose: vi.fn(),
      onSelect: vi.fn(),
      tabs: [
        {
          id: "repository:src/index.tsx",
          kind: "repository",
          path: "src/index.tsx",
          dirty: true,
        },
        {
          id: "run-1:tool-1",
          kind: "streaming",
          path: "src/generated.tsx",
          status: "streaming",
        },
      ],
    });

    expect(screen.getByLabelText("未保存")).toBeVisible();
    expect(screen.getByLabelText("Agent 正在生成文件内容")).toBeVisible();
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "generated.tsx",
    );
  });

  it("选择和关闭时回传稳定 tab id，而不是仅回传可能重名的路径", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelect = vi.fn();

    renderEditorTabs({
      activeId: "repository:src/index.tsx",
      onClose,
      onSelect,
      tabs: [
        {
          id: "repository:src/index.tsx",
          kind: "repository",
          path: "src/index.tsx",
          dirty: false,
        },
        {
          id: "run-1:tool-1",
          kind: "streaming",
          path: "src/index.tsx",
          status: "awaiting_repository",
        },
      ],
    });

    const streamingTab = screen.getAllByRole("tab")[1]!;
    await user.click(
      within(streamingTab).getByRole("button", {
        name: /^index\.tsx/,
      }),
    );
    await user.click(
      within(streamingTab).getByRole("button", {
        name: "关闭 src/index.tsx",
      }),
    );

    expect(onSelect).toHaveBeenCalledWith("run-1:tool-1");
    expect(onClose).toHaveBeenCalledWith("run-1:tool-1");
  });
});
