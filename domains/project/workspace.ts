import type { ProjectFileSnapshot } from "@/domains/project/types";

export type WorkspaceSaveStatus =
  "idle" | "saving" | "saved" | "conflict" | "error";

/**
 * 成功态和进行中状态只保存结构化事实，不在领域层拼接用户可见文案。
 * 具体语言由工作台组件根据当前 locale 决定；服务端错误仍通过
 * statusMessage 原样保留，避免翻译层覆盖有价值的诊断信息。
 */
export type WorkspaceStatusDetail =
  | { kind: "saving" }
  | { kind: "saved"; revision: number; hasNewDraft: boolean }
  | { kind: "created"; path: string }
  | { kind: "renamed"; path: string }
  | { kind: "deleted"; path: string }
  | null;

export type WorkspaceFile = ProjectFileSnapshot & {
  /**
   * serverContent 是当前客户端已确认写入 Repository 的内容，
   * draftContent 是 Monaco 正在编辑的本地草稿。两者分离后，
   * revision conflict 只更新服务端基线，不会覆盖用户尚未保存的文本。
   */
  serverContent: string;
  draftContent: string;
  dirty: boolean;
  // 冲突刷新时服务端可能已经删除该路径；此标记避免运行镜像继续包含仅存于本地的草稿。
  repositoryPresent: boolean;
};

export type WorkspaceConflict = {
  actualRevision: number | null;
  expectedRevision: number;
  message: string;
};

export type ProjectWorkspaceState = {
  files: Record<string, WorkspaceFile>;
  openPaths: string[];
  activePath: string | null;
  revision: number;
  saveStatus: WorkspaceSaveStatus;
  statusDetail: WorkspaceStatusDetail;
  statusMessage: string;
  conflict: WorkspaceConflict | null;
};

export type WorkspaceAction =
  | { type: "open"; path: string }
  | { type: "close"; path: string }
  | { type: "edit"; path: string; content: string }
  | { type: "save-start" }
  | {
      type: "save-success";
      path: string;
      revision: number;
      file: ProjectFileSnapshot;
    }
  | {
      type: "create-success";
      revision: number;
      file: ProjectFileSnapshot;
    }
  | {
      type: "rename-success";
      fromPath: string;
      revision: number;
      file: ProjectFileSnapshot;
    }
  | { type: "delete-success"; path: string; revision: number }
  | {
      type: "conflict";
      actualRevision: number | null;
      expectedRevision: number;
      message: string;
    }
  | { type: "error"; message: string }
  | {
      type: "reconcile";
      files: readonly ProjectFileSnapshot[];
      revision: number;
    }
  | { type: "clear-status" };

export function createProjectWorkspaceState(
  files: readonly ProjectFileSnapshot[],
  revision: number,
): ProjectWorkspaceState {
  const normalizedFiles = Object.fromEntries(
    files.map((file) => [file.path, toWorkspaceFile(file)]),
  );
  const firstPath =
    files.find((file) => file.path === "src/index.tsx")?.path ??
    files.find((file) => file.path.endsWith(".tsx"))?.path ??
    files[0]?.path ??
    null;

  return {
    files: normalizedFiles,
    openPaths: firstPath ? [firstPath] : [],
    activePath: firstPath,
    revision,
    saveStatus: "idle",
    statusDetail: null,
    statusMessage: "",
    conflict: null,
  };
}

export function projectWorkspaceReducer(
  state: ProjectWorkspaceState,
  action: WorkspaceAction,
): ProjectWorkspaceState {
  switch (action.type) {
    case "open":
      if (!state.files[action.path]) {
        return state;
      }

      return {
        ...state,
        activePath: action.path,
        openPaths: state.openPaths.includes(action.path)
          ? state.openPaths
          : [...state.openPaths, action.path],
      };

    case "close": {
      const index = state.openPaths.indexOf(action.path);
      const openPaths = state.openPaths.filter((path) => path !== action.path);
      const activePath =
        state.activePath === action.path
          ? (openPaths[Math.min(index, openPaths.length - 1)] ?? null)
          : state.activePath;

      return { ...state, activePath, openPaths };
    }

    case "edit": {
      const file = state.files[action.path];

      if (!file) {
        return state;
      }

      return {
        ...state,
        files: {
          ...state.files,
          [action.path]: {
            ...file,
            draftContent: action.content,
            dirty: action.content !== file.serverContent,
          },
        },
        // 用户继续编辑代表正在处理冲突或错误，状态提示不应继续伪装为已保存。
        saveStatus: state.saveStatus === "saving" ? state.saveStatus : "idle",
        statusDetail: state.saveStatus === "saving" ? state.statusDetail : null,
        statusMessage: "",
      };
    }

    case "save-start":
      return {
        ...state,
        saveStatus: "saving",
        statusDetail: { kind: "saving" },
        statusMessage: "",
        conflict: null,
      };

    case "save-success":
      return applySavedFile(state, action.path, action.file, action.revision);

    case "create-success": {
      const created = toWorkspaceFile(action.file);

      return {
        ...state,
        files: { ...state.files, [created.path]: created },
        openPaths: state.openPaths.includes(created.path)
          ? state.openPaths
          : [...state.openPaths, created.path],
        activePath: created.path,
        revision: action.revision,
        saveStatus: "saved",
        statusDetail: { kind: "created", path: created.path },
        statusMessage: "",
        conflict: null,
      };
    }

    case "rename-success": {
      const files = { ...state.files };
      delete files[action.fromPath];
      files[action.file.path] = toWorkspaceFile(action.file);

      return {
        ...state,
        files,
        openPaths: state.openPaths.map((path) =>
          path === action.fromPath ? action.file.path : path,
        ),
        activePath:
          state.activePath === action.fromPath
            ? action.file.path
            : state.activePath,
        revision: action.revision,
        saveStatus: "saved",
        statusDetail: { kind: "renamed", path: action.file.path },
        statusMessage: "",
        conflict: null,
      };
    }

    case "delete-success": {
      const files = { ...state.files };
      delete files[action.path];
      const index = state.openPaths.indexOf(action.path);
      const openPaths = state.openPaths.filter((path) => path !== action.path);
      const activePath =
        state.activePath === action.path
          ? (openPaths[Math.min(index, openPaths.length - 1)] ?? null)
          : state.activePath;

      return {
        ...state,
        files,
        openPaths,
        activePath,
        revision: action.revision,
        saveStatus: "saved",
        statusDetail: { kind: "deleted", path: action.path },
        statusMessage: "",
        conflict: null,
      };
    }

    case "conflict":
      return {
        ...state,
        saveStatus: "conflict",
        statusDetail: null,
        statusMessage: action.message,
        conflict: {
          actualRevision: action.actualRevision,
          expectedRevision: action.expectedRevision,
          message: action.message,
        },
      };

    case "error":
      return {
        ...state,
        saveStatus: "error",
        statusDetail: null,
        statusMessage: action.message,
      };

    case "reconcile":
      return reconcileRepositorySnapshot(state, action.files, action.revision);

    case "clear-status":
      return {
        ...state,
        saveStatus: "idle",
        statusDetail: null,
        statusMessage: "",
        conflict: null,
      };
  }
}

export function selectDirtyPaths(state: ProjectWorkspaceState): string[] {
  return Object.values(state.files)
    .filter((file) => file.dirty)
    .map((file) => file.path)
    .sort();
}

export function hasDirtyFiles(state: ProjectWorkspaceState): boolean {
  return Object.values(state.files).some((file) => file.dirty);
}

function applySavedFile(
  state: ProjectWorkspaceState,
  path: string,
  file: ProjectFileSnapshot,
  revision: number,
): ProjectWorkspaceState {
  const current = state.files[path];
  // 请求发送后用户可能继续输入。只有草稿仍等于本次保存内容时才清除 dirty，
  // 否则保留更新后的草稿，防止慢请求把更晚的键盘输入标记成已保存。
  const draftContent = current?.draftContent ?? file.content;
  const savedDraftWasCurrent = draftContent === file.content;

  return {
    ...state,
    files: {
      ...state.files,
      [path]: {
        ...file,
        serverContent: file.content,
        draftContent,
        dirty: !savedDraftWasCurrent,
        repositoryPresent: true,
      },
    },
    revision,
    saveStatus: "saved",
    statusDetail: {
      kind: "saved",
      revision,
      hasNewDraft: !savedDraftWasCurrent,
    },
    statusMessage: "",
    conflict: null,
  };
}

function reconcileRepositorySnapshot(
  state: ProjectWorkspaceState,
  files: readonly ProjectFileSnapshot[],
  revision: number,
): ProjectWorkspaceState {
  const nextFiles: Record<string, WorkspaceFile> = {};

  for (const serverFile of files) {
    const current = state.files[serverFile.path];

    nextFiles[serverFile.path] =
      current?.dirty === true
        ? {
            ...serverFile,
            serverContent: serverFile.content,
            draftContent: current.draftContent,
            dirty: current.draftContent !== serverFile.content,
            repositoryPresent: true,
          }
        : toWorkspaceFile(serverFile);
  }

  // 服务端已删除但本地仍有未保存草稿的文件继续保留。
  // 用户可以复制内容或换路径保存，系统不会以刷新为由丢弃编辑成果。
  for (const file of Object.values(state.files)) {
    if (file.dirty && !nextFiles[file.path]) {
      nextFiles[file.path] = {
        ...file,
        repositoryPresent: false,
      };
    }
  }

  const existingPaths = new Set(Object.keys(nextFiles));
  const openPaths = state.openPaths.filter((path) => existingPaths.has(path));
  const activePath =
    state.activePath && existingPaths.has(state.activePath)
      ? state.activePath
      : (openPaths[0] ?? Object.keys(nextFiles).sort()[0] ?? null);

  return {
    ...state,
    files: nextFiles,
    openPaths:
      activePath && !openPaths.includes(activePath)
        ? [...openPaths, activePath]
        : openPaths,
    activePath,
    revision,
  };
}

function toWorkspaceFile(file: ProjectFileSnapshot): WorkspaceFile {
  return {
    ...file,
    serverContent: file.content,
    draftContent: file.content,
    dirty: false,
    repositoryPresent: true,
  };
}
