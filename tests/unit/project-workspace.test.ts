import { describe, expect, it } from "vitest";

import {
  createProjectWorkspaceState,
  hasDirtyFiles,
  projectWorkspaceReducer,
} from "@/domains/project/workspace";
import type { ProjectFileSnapshot } from "@/domains/project/types";

function file(path: string, content: string): ProjectFileSnapshot {
  return {
    path,
    content,
    byteLength: new TextEncoder().encode(content).byteLength,
    hash: `${path}-${content}`,
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("project workspace reducer", () => {
  it("维护多标签、活动文件和脏状态", () => {
    let state = createProjectWorkspaceState(
      [file("src/index.tsx", "index"), file("src/styles.css", "styles")],
      1,
    );

    state = projectWorkspaceReducer(state, {
      type: "open",
      path: "src/styles.css",
    });
    state = projectWorkspaceReducer(state, {
      type: "edit",
      path: "src/styles.css",
      content: "updated",
    });

    expect(state.openPaths).toEqual(["src/index.tsx", "src/styles.css"]);
    expect(state.activePath).toBe("src/styles.css");
    expect(state.files["src/styles.css"]?.dirty).toBe(true);
    expect(hasDirtyFiles(state)).toBe(true);

    state = projectWorkspaceReducer(state, {
      type: "close",
      path: "src/styles.css",
    });
    expect(state.activePath).toBe("src/index.tsx");
    // 关闭标签只影响视图，不能丢弃文件草稿。
    expect(state.files["src/styles.css"]?.draftContent).toBe("updated");
  });

  it("可以在后台打开 Agent 刚写入的正式文件而不抢占当前标签", () => {
    let state = createProjectWorkspaceState(
      [file("src/index.tsx", "index"), file("src/generated.ts", "generated")],
      2,
    );

    state = projectWorkspaceReducer(state, {
      type: "open",
      path: "src/generated.ts",
      activate: false,
    });

    expect(state.openPaths).toEqual(["src/index.tsx", "src/generated.ts"]);
    expect(state.activePath).toBe("src/index.tsx");
  });

  it("保存响应较慢时保留响应期间产生的新草稿", () => {
    let state = createProjectWorkspaceState(
      [file("src/index.tsx", "server")],
      1,
    );
    state = projectWorkspaceReducer(state, {
      type: "edit",
      path: "src/index.tsx",
      content: "sent-to-server",
    });
    state = projectWorkspaceReducer(state, { type: "save-start" });
    expect(state.statusDetail).toEqual({ kind: "saving" });
    state = projectWorkspaceReducer(state, {
      type: "edit",
      path: "src/index.tsx",
      content: "typed-while-saving",
    });
    expect(state.statusDetail).toEqual({ kind: "saving" });
    state = projectWorkspaceReducer(state, {
      type: "save-success",
      path: "src/index.tsx",
      revision: 2,
      file: file("src/index.tsx", "sent-to-server"),
    });

    expect(state.revision).toBe(2);
    expect(state.files["src/index.tsx"]).toMatchObject({
      serverContent: "sent-to-server",
      draftContent: "typed-while-saving",
      dirty: true,
    });
    expect(state.statusDetail).toEqual({
      kind: "saved",
      revision: 2,
      hasNewDraft: true,
    });
    expect(state.statusMessage).toBe("");
  });

  it("服务端冲突刷新时保留本地草稿并更新服务端基线", () => {
    let state = createProjectWorkspaceState(
      [file("src/index.tsx", "revision-1")],
      1,
    );
    state = projectWorkspaceReducer(state, {
      type: "edit",
      path: "src/index.tsx",
      content: "local-draft",
    });
    state = projectWorkspaceReducer(state, {
      type: "conflict",
      actualRevision: 2,
      expectedRevision: 1,
      message: "版本冲突",
    });
    state = projectWorkspaceReducer(state, {
      type: "reconcile",
      files: [file("src/index.tsx", "revision-2")],
      revision: 2,
    });

    expect(state.saveStatus).toBe("conflict");
    expect(state.files["src/index.tsx"]).toMatchObject({
      serverContent: "revision-2",
      draftContent: "local-draft",
      dirty: true,
      repositoryPresent: true,
    });
  });

  it("服务端删除文件后仅保留本地草稿，不再把它视为 Repository 文件", () => {
    let state = createProjectWorkspaceState(
      [file("src/index.tsx", "revision-1")],
      1,
    );
    state = projectWorkspaceReducer(state, {
      type: "edit",
      path: "src/index.tsx",
      content: "local-draft",
    });
    state = projectWorkspaceReducer(state, {
      type: "reconcile",
      files: [],
      revision: 2,
    });

    expect(state.files["src/index.tsx"]).toMatchObject({
      draftContent: "local-draft",
      dirty: true,
      repositoryPresent: false,
    });
  });

  it("重命名与删除同步更新标签页和活动文件", () => {
    let state = createProjectWorkspaceState(
      [file("src/index.tsx", "index"), file("src/styles.css", "styles")],
      1,
    );
    state = projectWorkspaceReducer(state, {
      type: "open",
      path: "src/styles.css",
    });
    state = projectWorkspaceReducer(state, {
      type: "rename-success",
      fromPath: "src/styles.css",
      revision: 2,
      file: file("src/theme.css", "styles"),
    });

    expect(state.activePath).toBe("src/theme.css");
    expect(state.openPaths).toContain("src/theme.css");
    expect(state.files["src/styles.css"]).toBeUndefined();
    expect(state.statusDetail).toEqual({
      kind: "renamed",
      path: "src/theme.css",
    });

    state = projectWorkspaceReducer(state, {
      type: "delete-success",
      path: "src/theme.css",
      revision: 3,
    });
    expect(state.activePath).toBe("src/index.tsx");
    expect(state.files["src/theme.css"]).toBeUndefined();
    expect(state.statusDetail).toEqual({
      kind: "deleted",
      path: "src/theme.css",
    });
  });
});
