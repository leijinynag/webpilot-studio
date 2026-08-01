"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { editor } from "monaco-editor";
import {
  Code2,
  ExternalLink,
  FilePlus2,
  GitBranch,
  Play,
  Save,
  WandSparkles,
} from "lucide-react";

import { WebContainerPreview } from "@/components/preview/webcontainer-preview";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CodeEditor } from "@/components/workbench/code-editor";
import { AgentPanel } from "@/components/workbench/agent-panel";
import { EditorTabs } from "@/components/workbench/editor-tabs";
import { FileOperationDialog } from "@/components/workbench/file-operation-dialog";
import { FileTree } from "@/components/workbench/file-tree";
import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import type {
  ClientToolRequest,
  ClientToolResult,
} from "@/domains/agent/client-tools";
import type {
  ProjectDescription,
  ProjectFileSnapshot,
  ProjectMutationResult,
} from "@/domains/project/types";
import {
  createProjectWorkspaceState,
  hasDirtyFiles,
  projectWorkspaceReducer,
  selectDirtyPaths,
} from "@/domains/project/workspace";
import { cn } from "@/lib/utils";

type WorkspaceView = "code" | "preview";
type FileOperation =
  | { mode: "create"; path: "" }
  | { mode: "rename"; path: string }
  | { mode: "delete"; path: string }
  | null;

type MutationResponse = {
  file: ProjectFileSnapshot;
  result: ProjectMutationResult;
};

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    details?: {
      actualRevision?: number;
      expectedRevision?: number;
    };
  };
};

export function ProjectWorkspace({
  initialFiles,
  project,
}: {
  initialFiles: readonly ProjectFileSnapshot[];
  project: ProjectDescription;
}) {
  const [state, dispatch] = useReducer(
    projectWorkspaceReducer,
    createProjectWorkspaceState(initialFiles, project.revision),
  );
  const [view, setView] = useState<WorkspaceView>("preview");
  const [operation, setOperation] = useState<FileOperation>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [agentRevision, setAgentRevision] = useState(project.revision);
  const [clientToolRequest, setClientToolRequest] =
    useState<ClientToolRequest | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const activeFile = state.activePath
    ? (state.files[state.activePath] ?? null)
    : null;
  const repositoryFiles = useMemo(
    () =>
      Object.values(state.files)
        .filter((file) => file.repositoryPresent)
        .map(toProjectFileSnapshot),
    [state.files],
  );
  const dirtyPaths = selectDirtyPaths(state);

  useEffect(() => {
    function confirmUnload(event: BeforeUnloadEvent) {
      if (!hasDirtyFiles(stateRef.current)) {
        return;
      }

      event.preventDefault();
    }

    window.addEventListener("beforeunload", confirmUnload);
    return () => window.removeEventListener("beforeunload", confirmUnload);
  }, []);

  async function saveActiveFile() {
    const current = stateRef.current;
    const path = current.activePath;
    const file = path ? current.files[path] : null;

    if (!path || !file || !file.dirty || current.saveStatus === "saving") {
      return;
    }

    dispatch({ type: "save-start" });
    try {
      const response = await fetch(`/api/projects/${project.id}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          content: file.draftContent,
          expectedRevision: current.revision,
        }),
      });

      if (!response.ok) {
        await handleMutationFailure(response, current.revision);
        return;
      }

      const body = (await response.json()) as MutationResponse;
      dispatch({
        type: "save-success",
        path,
        revision: body.result.revision,
        file: body.file,
      });
    } catch {
      // fetch 只有在网络层失败时才直接抛异常。这里必须显式结束 saving，
      // 否则按钮会永久禁用，而 Monaco 中的草稿仍应完整保留以便重试。
      dispatch({
        type: "error",
        message: "网络连接中断，本地草稿已保留，请稍后重试。",
      });
    }
  }

  async function handleMutationFailure(
    response: Response,
    expectedRevision: number,
  ) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    const message = body.error?.message ?? "文件操作失败，请稍后重试。";

    if (body.error?.code === PROJECT_ERROR_CODES.revisionConflict) {
      dispatch({
        type: "conflict",
        actualRevision: body.error.details?.actualRevision ?? null,
        expectedRevision,
        message: "Repository 已有更新，本地草稿仍被保留。",
      });
      await refreshRepositorySnapshot();
      return;
    }

    dispatch({ type: "error", message });
  }

  const refreshRepositorySnapshot = useCallback(async () => {
    try {
      const [projectResponse, filesResponse] = await Promise.all([
        fetch(`/api/projects/${project.id}`, { cache: "no-store" }),
        fetch(`/api/projects/${project.id}/files`, { cache: "no-store" }),
      ]);

      if (!projectResponse.ok || !filesResponse.ok) {
        dispatch({
          type: "error",
          message: "无法读取最新 Repository，请刷新页面后重试。",
        });
        return;
      }

      const projectBody = (await projectResponse.json()) as {
        project: ProjectDescription;
      };
      const filesBody = (await filesResponse.json()) as {
        files: ProjectFileSnapshot[];
      };
      dispatch({
        type: "reconcile",
        files: filesBody.files,
        revision: projectBody.project.revision,
      });
    } catch {
      dispatch({
        type: "error",
        message: "无法连接 Repository，本地草稿仍被保留。",
      });
    }
  }, [project.id]);

  function handleAgentRevisionChange(nextRevision: number) {
    setAgentRevision(nextRevision);

    // Agent mutation 已经写入 Repository 后，工作台必须重新读取服务端快照。
    // reducer 会保留 dirty draft，只替换没有本地修改的文件，避免静默覆盖用户输入。
    if (nextRevision > stateRef.current.revision) {
      void refreshRepositorySnapshot();
    }
  }

  async function handleRestoreComplete(nextRevision: number) {
    setAgentRevision(nextRevision);

    // Restore 与普通 Agent mutation 一样只改变 Repository 事实。
    // reconcile 会更新服务端基线，同时继续保留 Monaco 中尚未保存的 draft。
    await refreshRepositorySnapshot();
  }

  const handleClientToolRequest = useCallback(
    (request: ClientToolRequest) => {
      if (request.projectId !== project.id) {
        return;
      }

      setClientToolRequest((current) =>
        current?.toolCallId === request.toolCallId ? current : request,
      );
      setView("preview");

      // Tool Call 在文件 mutation 落库后才会下发。若 SSE 比工作台快照先到，
      // 主动拉取目标 revision；reducer 仍会保护用户尚未保存的本地草稿。
      if (request.revision > stateRef.current.revision) {
        void refreshRepositorySnapshot();
      }
    },
    [project.id, refreshRepositorySnapshot],
  );

  const handleClientToolResult = useCallback(
    async (request: ClientToolRequest, result: ClientToolResult) => {
      try {
        const response = await fetch(
          `/api/agent-runs/${request.runId}/client-tool-results`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: request.projectId,
              toolCallId: request.toolCallId,
              toolName: request.toolName,
              idempotencyKey: request.idempotencyKey,
              revision: request.revision,
              result,
            }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          disposition?: "accepted" | "duplicate" | "ignored";
          error?: { message?: string };
        };

        if (!response.ok) {
          throw new Error(body.error?.message ?? "Preview 证据提交失败。");
        }

        const disposition = body.disposition ?? "ignored";

        // ignored 表示服务端尚未接纳这份结果，客户端请求仍然有效。此时若先清空，
        // 普通 Repository 预览会立即移除 Runtime Bridge，Agent 快照又会重建
        // 同一请求，两个运行镜像便会在同一 revision 上来回覆盖。
        if (disposition !== "ignored") {
          setClientToolRequest((current) =>
            current?.toolCallId === request.toolCallId ? null : current,
          );
        }
        return disposition;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Preview 证据提交失败，请稍后重试。";
        dispatch({
          type: "error",
          message,
        });
        throw error instanceof Error ? error : new Error(message);
      }
    },
    [],
  );

  async function submitFileOperation(value: string) {
    if (!operation || mutationPending) {
      return;
    }

    const current = stateRef.current;
    const dirtyTarget =
      operation.mode !== "create" && current.files[operation.path]?.dirty;

    if (
      dirtyTarget &&
      !window.confirm("该文件有未保存修改，继续会丢弃这份本地草稿。")
    ) {
      return;
    }

    setMutationPending(true);

    try {
      if (operation.mode === "create") {
        const response = await fetch(`/api/projects/${project.id}/files`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path: value,
            content: getInitialFileContent(value),
            expectedRevision: current.revision,
          }),
        });

        if (!response.ok) {
          await handleMutationFailure(response, current.revision);
          return;
        }

        const body = (await response.json()) as MutationResponse;
        dispatch({
          type: "create-success",
          revision: body.result.revision,
          file: body.file,
        });
      } else if (operation.mode === "rename") {
        const response = await fetch(`/api/projects/${project.id}/files`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromPath: operation.path,
            toPath: value,
            expectedRevision: current.revision,
          }),
        });

        if (!response.ok) {
          await handleMutationFailure(response, current.revision);
          return;
        }

        const body = (await response.json()) as MutationResponse;
        dispatch({
          type: "rename-success",
          fromPath: operation.path,
          revision: body.result.revision,
          file: body.file,
        });
      } else {
        const query = new URLSearchParams({
          path: operation.path,
          expectedRevision: current.revision.toString(),
        });
        const response = await fetch(
          `/api/projects/${project.id}/files?${query}`,
          { method: "DELETE" },
        );

        if (!response.ok) {
          await handleMutationFailure(response, current.revision);
          return;
        }

        const body = (await response.json()) as {
          result: ProjectMutationResult;
        };
        dispatch({
          type: "delete-success",
          path: operation.path,
          revision: body.result.revision,
        });
      }

      setOperation(null);
    } catch {
      // 文件创建、重命名和删除都以 Repository 为事实来源。
      // 网络失败时不提前修改本地树，避免 UI 展示从未成功落库的结构。
      dispatch({
        type: "error",
        message: "网络连接中断，文件操作尚未写入 Repository。",
      });
    } finally {
      setMutationPending(false);
    }
  }

  async function formatActiveFile() {
    const editor = editorRef.current;

    if (!editor) {
      return;
    }

    await editor.getAction("editor.action.formatDocument")?.run();
    editor.focus();
  }

  function closeFile(path: string) {
    const file = state.files[path];

    if (
      file?.dirty &&
      !window.confirm("关闭标签不会删除文件，但会保留未保存草稿。继续关闭？")
    ) {
      return;
    }

    dispatch({ type: "close", path });
  }

  function handleWorkbenchLink(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const link = target.closest("a");

    if (
      link &&
      hasDirtyFiles(stateRef.current) &&
      !window.confirm("仍有未保存文件，确认离开当前项目？")
    ) {
      event.preventDefault();
    }
  }

  return (
    <div
      className="workbench-page page-in"
      onClickCapture={handleWorkbenchLink}
    >
      <header className="workbench-top">
        <div className="project-crumb">
          <Link href="/">Projects</Link>
          <span>/</span>
          <b>{project.name}</b>
          <span
            aria-label={`Repository revision ${state.revision}`}
            className="revision-pill"
          >
            r{state.revision}
          </span>
        </div>

        <ToggleGroup
          aria-label="工作台视图"
          className="workbench-tabs"
          onValueChange={(value) => {
            if (value === "code" || value === "preview") {
              setView(value);
            }
          }}
          type="single"
          value={view}
        >
          <ToggleGroupItem value="preview">
            <Play />
            Preview
          </ToggleGroupItem>
          <ToggleGroupItem value="code">
            <Code2 />
            Code
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="workbench-actions">
          <Button asChild size="sm" variant="outline">
            <Link href={`/p/${project.id}/source-control`}>
              <GitBranch data-icon="inline-start" />
              Source Control
            </Link>
          </Button>
          <Button asChild className="app-button-accent" size="sm">
            <Link href={`/p/${project.id}/publish`}>
              <ExternalLink data-icon="inline-start" />
              Publish
            </Link>
          </Button>
        </div>
      </header>

      <div className="workbench-grid">
        <AgentPanel
          dirtyPaths={dirtyPaths}
          onClientToolRequest={handleClientToolRequest}
          onRevisionChange={handleAgentRevisionChange}
          onRestoreComplete={handleRestoreComplete}
          projectId={project.id}
          revision={agentRevision}
        />
        <section className="workspace workspace-ide">
          <div className="ide-sidebar">
            <div aria-label="Explorer" className="ide-panel-heading">
              <span>
                Explorer
                <small>{Object.keys(state.files).length}</small>
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="新建文件"
                    onClick={() => setOperation({ mode: "create", path: "" })}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <FilePlus2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>新建文件</TooltipContent>
              </Tooltip>
            </div>
            <FileTree
              activePath={state.activePath}
              files={state.files}
              onDelete={(path) => setOperation({ mode: "delete", path })}
              onOpen={(path) => {
                dispatch({ type: "open", path });
                setView("code");
              }}
              onRename={(path) => setOperation({ mode: "rename", path })}
            />
          </div>

          <div className="ide-main">
            <div className="ide-toolbar">
              {view === "code" ? (
                <>
                  <EditorTabs
                    activePath={state.activePath}
                    files={state.files}
                    onClose={closeFile}
                    onSelect={(path) => dispatch({ type: "open", path })}
                    openPaths={state.openPaths}
                  />
                  <div className="editor-actions">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          aria-label="格式化当前文件"
                          disabled={!activeFile}
                          onClick={formatActiveFile}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <WandSparkles />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>格式化当前文件</TooltipContent>
                    </Tooltip>
                    <Button
                      disabled={
                        !activeFile?.dirty || state.saveStatus === "saving"
                      }
                      onClick={saveActiveFile}
                      size="sm"
                    >
                      <Save data-icon="inline-start" />
                      {state.saveStatus === "saving" ? "Saving" : "Save"}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="preview-heading">
                  <span>Live preview</span>
                  <small>r{Math.max(state.revision, agentRevision)}</small>
                </div>
              )}
            </div>

            <div
              className={cn("ide-surface", view === "preview" && "is-preview")}
            >
              {view === "code" ? (
                activeFile ? (
                  <CodeEditor
                    file={activeFile}
                    onChange={(content) =>
                      dispatch({
                        type: "edit",
                        path: activeFile.path,
                        content,
                      })
                    }
                    onEditorReady={(editorInstance) => {
                      editorRef.current = editorInstance;
                    }}
                    onSave={saveActiveFile}
                  />
                ) : (
                  <div className="editor-empty">
                    <Code2 />
                    <span>从文件树中打开一个文件</span>
                  </div>
                )
              ) : (
                <WebContainerPreview
                  clientToolRequest={clientToolRequest}
                  files={repositoryFiles}
                  onClientToolResult={handleClientToolResult}
                  projectId={project.id}
                  revision={state.revision}
                />
              )}
            </div>

            <footer
              className={cn(
                "workspace-statusbar",
                state.saveStatus === "conflict" && "is-conflict",
                state.saveStatus === "error" && "is-error",
              )}
            >
              <span>
                {state.statusMessage ||
                  (dirtyPaths.length > 0
                    ? `${dirtyPaths.length} 个文件未保存`
                    : `Repository revision ${state.revision}`)}
              </span>
              {activeFile ? <span>{activeFile.path}</span> : null}
            </footer>
          </div>
        </section>
      </div>

      {operation ? (
        <FileOperationDialog
          initialValue={operation.path}
          key={`${operation.mode}:${operation.path}`}
          mode={operation.mode}
          onOpenChange={(open) => {
            if (!open) {
              setOperation(null);
            }
          }}
          onSubmit={submitFileOperation}
          open
          pending={mutationPending}
        />
      ) : null}
    </div>
  );
}

function toProjectFileSnapshot(file: {
  path: string;
  serverContent: string;
  byteLength: number;
  hash: string;
  updatedAt: string;
}): ProjectFileSnapshot {
  return {
    path: file.path,
    content: file.serverContent,
    byteLength: file.byteLength,
    hash: file.hash,
    updatedAt: file.updatedAt,
  };
}

function getInitialFileContent(path: string): string {
  if (path.endsWith(".tsx")) {
    return "export function Component() {\n  return <div />;\n}\n";
  }

  if (path.endsWith(".css")) {
    return "/* 新文件 */\n";
  }

  if (path.endsWith(".json")) {
    return "{}\n";
  }

  return "";
}
