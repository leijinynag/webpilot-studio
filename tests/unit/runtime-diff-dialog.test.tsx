import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  RuntimeDiffDialog,
  type RuntimeDiffDialogProps,
} from "@/components/preview/runtime-diff-dialog";
import type { RuntimeFileDiff } from "@/domains/project/types";

const {
  disposeModifiedModel,
  disposeOriginalModel,
  onDidDispose,
  capturedDiffEditorProps,
} = vi.hoisted(() => ({
  disposeModifiedModel: vi.fn(),
  disposeOriginalModel: vi.fn(),
  onDidDispose: vi.fn(),
  capturedDiffEditorProps: {
    current: null as
      | (ComponentProps<"div"> & {
          keepCurrentModifiedModel?: boolean;
          keepCurrentOriginalModel?: boolean;
          onMount?: (editor: {
            getModel: () => {
              modified: { dispose: () => void };
              original: { dispose: () => void };
            };
            onDidDispose: (listener: () => void) => void;
          }) => void;
        })
      | null,
  },
}));

vi.mock("@/components/workbench/monaco-client", () => ({
  loadLocalMonacoReact: async () => ({
    DiffEditor: (props: typeof capturedDiffEditorProps.current) => {
      capturedDiffEditorProps.current = props;
      props?.onMount?.({
        getModel: () => ({
          modified: { dispose: disposeModifiedModel },
          original: { dispose: disposeOriginalModel },
        }),
        onDidDispose,
      });
      return <div data-testid="runtime-diff-editor" />;
    },
  }),
}));

const runtimeDiff: RuntimeFileDiff = {
  projectKey: "22222222-2222-4222-8222-222222222222",
  baseRevision: 2,
  entries: [
    {
      path: "src/index.tsx",
      status: "modified",
      beforeContent: "export const title = 'before';",
      afterContent: "export const title = 'after';",
    },
  ],
};

function renderDialog(overrides: Partial<RuntimeDiffDialogProps> = {}) {
  return render(
    <RuntimeDiffDialog
      diff={runtimeDiff}
      dirtyPaths={[]}
      errorMessage={null}
      loading={false}
      onImport={async () => ({ status: "imported", revision: 3 })}
      onOpenChange={vi.fn()}
      onRescan={vi.fn()}
      open
      {...overrides}
    />,
  );
}

describe("RuntimeDiffDialog", () => {
  it("先卸载 DiffEditor，再释放其独占 TextModel", async () => {
    renderDialog();

    expect(await screen.findByTestId("runtime-diff-editor")).toBeVisible();
    expect(capturedDiffEditorProps.current).toMatchObject({
      keepCurrentModifiedModel: true,
      keepCurrentOriginalModel: true,
    });
    expect(onDidDispose).toHaveBeenCalledTimes(1);

    // 回调由 Monaco 在 DiffEditor 自身 dispose 完成后触发。测试主动执行，
    // 验证原始与修改模型都由业务组件负责回收，避免修复错误后形成内存泄漏。
    const disposeAfterEditor = onDidDispose.mock.calls[0]?.[0];
    expect(disposeAfterEditor).toBeTypeOf("function");
    disposeAfterEditor?.();
    expect(disposeOriginalModel).toHaveBeenCalledTimes(1);
    expect(disposeModifiedModel).toHaveBeenCalledTimes(1);
  });

  it("导入成功时关闭弹窗，但不把临时 Diff 当作 Repository 状态保留", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onImport = vi.fn(async () => ({
      status: "imported" as const,
      revision: 3,
    }));
    renderDialog({ onImport, onOpenChange });

    await user.click(
      await screen.findByRole("button", { name: "导入 1 个文件" }),
    );

    expect(onImport).toHaveBeenCalledWith(runtimeDiff, runtimeDiff.entries);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
