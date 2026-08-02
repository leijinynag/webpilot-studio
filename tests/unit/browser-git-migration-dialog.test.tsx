import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserGitMigrationDialog } from "@/components/workbench/browser-git-migration-dialog";
import {
  BrowserGitMigrationRecoveryRequiredError,
  type BrowserGitMigrationController,
} from "@/domains/project/browser-git-migration-client";
import type { ProjectDescription } from "@/domains/project/types";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

const project: ProjectDescription = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Migration dialog",
  storageKind: "database",
  status: "ready",
  revision: 3,
  fileCount: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null,
};

function createController(input?: {
  canRecover?: () => boolean;
  migrate?: BrowserGitMigrationController["migrate"];
  recover?: BrowserGitMigrationController["recover"];
}) {
  return {
    get canRecover() {
      return input?.canRecover?.() ?? false;
    },
    migrate:
      input?.migrate ??
      vi.fn<BrowserGitMigrationController["migrate"]>().mockResolvedValue({
        ...project,
        storageKind: "browser_git",
      }),
    recover:
      input?.recover ??
      vi.fn<BrowserGitMigrationController["recover"]>().mockResolvedValue({
        ...project,
        storageKind: "browser_git",
      }),
  } as BrowserGitMigrationController;
}

describe("BrowserGitMigrationDialog", () => {
  afterEach(() => {
    cleanup();
    refresh.mockReset();
  });

  it("blocks migration while Monaco still has dirty drafts", async () => {
    const user = userEvent.setup();
    const controller = createController();

    render(
      <BrowserGitMigrationDialog
        controller={controller}
        dirtyPaths={["src/index.tsx", "src/styles.css"]}
        project={project}
      />,
    );

    await user.click(screen.getByRole("button", { name: "迁移" }));

    expect(
      screen.getByRole("heading", { name: "迁移到 Browser Git" }),
    ).toBeVisible();
    expect(screen.getByText("2 个 Monaco 草稿尚未保存")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始迁移" })).toBeDisabled();
    expect(controller.migrate).not.toHaveBeenCalled();
  });

  it("runs migration stages and refreshes the Server Component after confirmation", async () => {
    const user = userEvent.setup();
    const migrate = vi
      .fn<BrowserGitMigrationController["migrate"]>()
      .mockImplementation(async ({ onStage }) => {
        onStage?.("preparing");
        onStage?.("creating_candidate");
        onStage?.("validating_candidate");
        onStage?.("promoting");
        onStage?.("finalizing");
        onStage?.("completed");
        return { ...project, storageKind: "browser_git" };
      });
    const controller = createController({ migrate });

    render(
      <BrowserGitMigrationDialog
        controller={controller}
        dirtyPaths={[]}
        project={project}
      />,
    );

    await user.click(screen.getByRole("button", { name: "迁移" }));
    await user.click(screen.getByRole("button", { name: "开始迁移" }));

    expect(await screen.findByText("迁移完成")).toBeVisible();
    expect(screen.getByRole("status")).toContainElement(
      screen.getByText("迁移完成"),
    );
    expect(migrate).toHaveBeenCalledWith({
      project,
      onStage: expect.any(Function),
    });
    // 成功结果需要先留在弹窗中，让用户确认迁移已经完成；
    // 只有点击“完成”关闭结果弹窗时，Server Component 才重新读取 storageKind。
    expect(refresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("offers recovery with the preserved finalize proof after an unknown response", async () => {
    const user = userEvent.setup();
    let canRecover = false;
    const migrate = vi
      .fn<BrowserGitMigrationController["migrate"]>()
      .mockImplementation(async () => {
        canRecover = true;
        throw new BrowserGitMigrationRecoveryRequiredError(
          "无法确认服务端是否已经完成切换。",
        );
      });
    const recover = vi
      .fn<BrowserGitMigrationController["recover"]>()
      .mockResolvedValue({ ...project, storageKind: "browser_git" });
    const controller = createController({
      canRecover: () => canRecover,
      migrate,
      recover,
    });

    render(
      <BrowserGitMigrationDialog
        controller={controller}
        dirtyPaths={[]}
        project={project}
      />,
    );

    await user.click(screen.getByRole("button", { name: "迁移" }));
    await user.click(screen.getByRole("button", { name: "开始迁移" }));

    expect(await screen.findByText("需要确认迁移状态")).toBeVisible();
    expect(screen.getByRole("alert")).toContainElement(
      screen.getByText("需要确认迁移状态"),
    );
    const retryButton = screen.getByRole("button", { name: "重试确认" });
    await user.click(retryButton);

    await waitFor(() => {
      expect(recover).toHaveBeenCalledWith({
        projectId: project.id,
        onStage: expect.any(Function),
      });
    });
    expect(migrate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "完成" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
