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
import { BrowserGitMigrationDialog } from "@/components/workbench/browser-git-migration-dialog";
import { EditorTabs } from "@/components/workbench/editor-tabs";
import { FileOperationDialog } from "@/components/workbench/file-operation-dialog";
import { FileTree } from "@/components/workbench/file-tree";
import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import { BrowserGitProjectRepository } from "@/domains/project/browser-git-repository";
import { browserApiFetch } from "@/infrastructure/http/browser-api";
import type {
  BrowserRepositoryClientToolRequest,
  ClientToolRequest,
  ClientToolResult,
} from "@/domains/agent/client-tools";
import { isPreviewClientToolRequest } from "@/domains/agent/client-tools";
import {
  createBrowserRepositoryToolFailure,
  executeBrowserRepositoryClientTool,
} from "@/domains/agent/browser-git-client-tools";
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
  type WorkspaceStatusDetail,
} from "@/domains/project/workspace";
import { useUiI18n } from "@/infrastructure/i18n/ui";
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

class ClientToolResultSubmissionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ClientToolResultSubmissionError";
  }
}

export function ProjectWorkspace({
  initialFiles,
  project,
}: {
  initialFiles: readonly ProjectFileSnapshot[];
  project: ProjectDescription;
}) {
  const { t } = useUiI18n();
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
  const browserGitRepository = useMemo(
    () =>
      project.storageKind === "browser_git"
        ? new BrowserGitProjectRepository(project)
        : null,
    [project],
  );
  const [repositoryReady, setRepositoryReady] = useState(
    project.storageKind === "database",
  );
  const [repositoryUnavailable, setRepositoryUnavailable] = useState<
    string | null
  >(
    project.status === "unavailable" ? t("workbench.repositoryDataLost") : null,
  );
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // SSE 实时事件与快照恢复可能在同一个 Tool Call 上交错到达。
  // executing 防止并发执行，completed 则阻止首次结果已经被服务端接纳后，
  // 迟到快照再次触发本地仓库副作用。
  const executingRepositoryToolsRef = useRef(new Set<string>());
  const repositoryToolResultsRef = useRef(
    new Map<
      string,
      {
        request: BrowserRepositoryClientToolRequest;
        result: ClientToolResult;
      }
    >(),
  );
  const completedRepositoryToolsRef = useRef(new Set<string>());
  const repositoryToolRetryTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const repositoryToolRetryAttemptsRef = useRef(new Map<string, number>());
  const [repositoryToolRetryNonce, setRepositoryToolRetryNonce] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const retryTimers = repositoryToolRetryTimersRef.current;
    return () => {
      for (const timer of retryTimers.values()) {
        clearTimeout(timer);
      }
      retryTimers.clear();
    };
  }, []);

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
  const localizedStatusMessage = formatWorkspaceStatusDetail(
    state.statusDetail,
    t,
  );

  useEffect(() => {
    // 发布页无法访问另一个路由实例中的 reducer，因此只同步“是否有草稿”
    // 这项跨页面事实，不同步正文，避免把 Monaco 内容复制到持久化存储。
    const key = `webpilot:dirty-drafts:${project.id}`;
    if (dirtyPaths.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }

    window.sessionStorage.setItem(key, JSON.stringify(dirtyPaths));
  }, [dirtyPaths, project.id]);

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

  useEffect(() => {
    const repository = browserGitRepository;

    if (!repository) {
      return;
    }

    let cancelled = false;

    async function initializeBrowserRepository() {
      setRepositoryReady(false);
      setRepositoryUnavailable(null);
      try {
        await repository!.initialize();
        const [files, gitState] = await Promise.all([
          repository!.listFiles(),
          repository!.getGitState(),
        ]);

        if (!cancelled) {
          dispatch({
            type: "reconcile",
            files,
            revision: gitState.revision,
          });
          setAgentRevision(gitState.revision);
          setRepositoryReady(true);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error
              ? error.message
              : t("workbench.repositoryRestoreFailed");
          setRepositoryUnavailable(message);
          dispatch({
            type: "error",
            message,
          });
        }
      }
    }

    void initializeBrowserRepository();
    return () => {
      cancelled = true;
    };
  }, [browserGitRepository, t]);

  async function saveActiveFile() {
    const current = stateRef.current;
    const path = current.activePath;
    const file = path ? current.files[path] : null;

    if (!path || !file || !file.dirty || current.saveStatus === "saving") {
      return;
    }

    dispatch({ type: "save-start" });
    try {
      if (browserGitRepository) {
        const result = await browserGitRepository.writeFile({
          path,
          content: file.draftContent,
          expectedRevision: current.revision,
        });
        const savedFile = await browserGitRepository.readFile({ path });
        dispatch({
          type: "save-success",
          path,
          revision: result.revision,
          file: savedFile,
        });
        return;
      }

      const response = await browserApiFetch(
        `/api/projects/${project.id}/files`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path,
            content: file.draftContent,
            expectedRevision: current.revision,
          }),
        },
      );

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
        message: t("workbench.networkDraftPreserved"),
      });
    }
  }

  async function handleMutationFailure(
    response: Response,
    expectedRevision: number,
  ) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    const message = body.error?.message ?? t("workbench.fileOperationFailed");

    if (body.error?.code === PROJECT_ERROR_CODES.revisionConflict) {
      dispatch({
        type: "conflict",
        actualRevision: body.error.details?.actualRevision ?? null,
        expectedRevision,
        message: t("workbench.repositoryUpdated"),
      });
      await refreshRepositorySnapshot();
      return;
    }

    dispatch({ type: "error", message });
  }

  const refreshRepositorySnapshot = useCallback(async () => {
    try {
      if (browserGitRepository) {
        const [files, gitState] = await Promise.all([
          browserGitRepository.listFiles(),
          browserGitRepository.getGitState(),
        ]);
        dispatch({
          type: "reconcile",
          files,
          revision: gitState.revision,
        });
        setAgentRevision(gitState.revision);
        return;
      }

      const [projectResponse, filesResponse] = await Promise.all([
        browserApiFetch(`/api/projects/${project.id}`, { cache: "no-store" }),
        browserApiFetch(`/api/projects/${project.id}/files`, {
          cache: "no-store",
        }),
      ]);

      if (!projectResponse.ok || !filesResponse.ok) {
        dispatch({
          type: "error",
          message: t("workbench.repositoryReadFailed"),
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
        message: t("workbench.repositoryConnectionFailed"),
      });
    }
  }, [browserGitRepository, project.id, t]);

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

      if (
        !isPreviewClientToolRequest(request) &&
        (executingRepositoryToolsRef.current.has(request.idempotencyKey) ||
          completedRepositoryToolsRef.current.has(request.idempotencyKey))
      ) {
        // 同一幂等键已经在本页面执行或收到服务端响应，不能再次读取/修改本地仓库。
        // 服务端 Ledger 仍然负责跨页面和跨实例的最终幂等校验。
        return;
      }

      setClientToolRequest((current) =>
        current?.toolCallId === request.toolCallId ? current : request,
      );
      if (isPreviewClientToolRequest(request)) {
        setView("preview");
      }

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
        const response = await browserApiFetch(
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
          throw new ClientToolResultSubmissionError(
            body.error?.message ?? t("workbench.clientToolResultFailed"),
            response.status >= 500 ||
              response.status === 408 ||
              response.status === 425 ||
              response.status === 429,
          );
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
        const submissionError =
          error instanceof ClientToolResultSubmissionError
            ? error
            : new ClientToolResultSubmissionError(
                error instanceof Error
                  ? error.message
                  : t("workbench.clientToolResultRetry"),
                true,
              );
        dispatch({
          type: "error",
          message: submissionError.message,
        });
        throw submissionError;
      }
    },
    [t],
  );

  useEffect(() => {
    if (
      !clientToolRequest ||
      isPreviewClientToolRequest(clientToolRequest) ||
      executingRepositoryToolsRef.current.has(
        clientToolRequest.idempotencyKey,
      ) ||
      completedRepositoryToolsRef.current.has(clientToolRequest.idempotencyKey)
    ) {
      return;
    }

    const request = clientToolRequest as BrowserRepositoryClientToolRequest;
    executingRepositoryToolsRef.current.add(request.idempotencyKey);

    async function executeRepositoryTool() {
      try {
        const cached = repositoryToolResultsRef.current.get(
          request.idempotencyKey,
        );
        let result: ClientToolResult;

        if (cached?.request.toolCallId === request.toolCallId) {
          result = cached.result;
        } else if (!browserGitRepository || !repositoryReady) {
          const unavailableError = new Error(
            repositoryUnavailable ?? t("workbench.browserGitNotReady"),
          );
          result = createBrowserRepositoryToolFailure(
            request,
            unavailableError,
          );
          dispatch({
            type: "error",
            message: unavailableError.message,
          });
        } else {
          result = await executeBrowserRepositoryClientTool({
            repository: browserGitRepository,
            request,
          });
        }

        repositoryToolResultsRef.current.set(request.idempotencyKey, {
          request,
          result,
        });
        const disposition = await handleClientToolResult(request, result);

        // 只要服务端已经明确返回 disposition，本次本地执行就结束。
        // ignored 可能表示 Run 已被其他恢复路径推进；再次执行 mutation
        // 只会让本地 revision 和服务端 Ledger 进一步分叉。
        completedRepositoryToolsRef.current.add(request.idempotencyKey);
        if (disposition !== "ignored") {
          await refreshRepositorySnapshot();
        }
        repositoryToolRetryAttemptsRef.current.delete(request.idempotencyKey);
      } catch (error) {
        dispatch({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : t("workbench.browserRepositoryToolFailed"),
        });

        // 结果提交失败时保留同一个请求和已执行结果。只有明确可重试的
        // 网络/服务端错误才自动再次提交，409 等业务冲突必须停下来交给
        // 服务端事实处理，避免把真正的 revision 问题变成无限重试。
        if (
          error instanceof ClientToolResultSubmissionError &&
          error.retryable &&
          repositoryToolResultsRef.current.has(request.idempotencyKey) &&
          !repositoryToolRetryTimersRef.current.has(request.idempotencyKey)
        ) {
          const attempt =
            (repositoryToolRetryAttemptsRef.current.get(
              request.idempotencyKey,
            ) ?? 0) + 1;
          repositoryToolRetryAttemptsRef.current.set(
            request.idempotencyKey,
            attempt,
          );
          const delayMs = Math.min(1_000 * 2 ** (attempt - 1), 8_000);
          const timer = setTimeout(() => {
            repositoryToolRetryTimersRef.current.delete(request.idempotencyKey);
            setRepositoryToolRetryNonce((current) => current + 1);
          }, delayMs);
          repositoryToolRetryTimersRef.current.set(
            request.idempotencyKey,
            timer,
          );
        }
      } finally {
        executingRepositoryToolsRef.current.delete(request.idempotencyKey);
      }
    }

    void executeRepositoryTool();
  }, [
    browserGitRepository,
    clientToolRequest,
    handleClientToolResult,
    refreshRepositorySnapshot,
    repositoryReady,
    repositoryUnavailable,
    repositoryToolRetryNonce,
    t,
  ]);

  async function submitFileOperation(value: string) {
    if (!operation || mutationPending) {
      return;
    }

    const current = stateRef.current;
    const dirtyTarget =
      operation.mode !== "create" && current.files[operation.path]?.dirty;

    if (dirtyTarget && !window.confirm(t("workbench.discardDraft"))) {
      return;
    }

    setMutationPending(true);

    try {
      if (operation.mode === "create") {
        if (browserGitRepository) {
          const result = await browserGitRepository.writeFile({
            path: value,
            content: getInitialFileContent(value),
            expectedRevision: current.revision,
          });
          const file = await browserGitRepository.readFile({ path: value });
          dispatch({
            type: "create-success",
            revision: result.revision,
            file,
          });
          setOperation(null);
          return;
        }

        const response = await browserApiFetch(
          `/api/projects/${project.id}/files`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              path: value,
              content: getInitialFileContent(value),
              expectedRevision: current.revision,
            }),
          },
        );

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
        if (browserGitRepository) {
          const result = await browserGitRepository.renameFile({
            fromPath: operation.path,
            toPath: value,
            expectedRevision: current.revision,
          });
          const file = await browserGitRepository.readFile({ path: value });
          dispatch({
            type: "rename-success",
            fromPath: operation.path,
            revision: result.revision,
            file,
          });
          setOperation(null);
          return;
        }

        const response = await browserApiFetch(
          `/api/projects/${project.id}/files`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              fromPath: operation.path,
              toPath: value,
              expectedRevision: current.revision,
            }),
          },
        );

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
        if (browserGitRepository) {
          const result = await browserGitRepository.deleteFile({
            path: operation.path,
            expectedRevision: current.revision,
          });
          dispatch({
            type: "delete-success",
            path: operation.path,
            revision: result.revision,
          });
          setOperation(null);
          return;
        }

        const query = new URLSearchParams({
          path: operation.path,
          expectedRevision: current.revision.toString(),
        });
        const response = await browserApiFetch(
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
        message: t("workbench.fileMutationNetworkFailed"),
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

    if (file?.dirty && !window.confirm(t("workbench.closeTab"))) {
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
      !window.confirm(t("workbench.leaveProject"))
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
          <Link href="/">{t("workbench.projects")}</Link>
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
          aria-label={t("workbench.view")}
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
            {t("workbench.preview")}
          </ToggleGroupItem>
          <ToggleGroupItem value="code">
            <Code2 />
            {t("workbench.code")}
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="workbench-actions">
          {project.storageKind === "database" ? (
            <BrowserGitMigrationDialog
              dirtyPaths={dirtyPaths}
              project={project}
            />
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/p/${project.id}/source-control`}>
              <GitBranch data-icon="inline-start" />
              {t("workbench.sourceControl")}
            </Link>
          </Button>
          <Button asChild className="app-button-accent" size="sm">
            <Link href={`/p/${project.id}/publish`}>
              <ExternalLink data-icon="inline-start" />
              {t("workbench.publish")}
            </Link>
          </Button>
        </div>
      </header>

      {!repositoryReady && !repositoryUnavailable ? (
        <div className="workspace-repository-loading" role="status">
          {t("workbench.restoringRepository")}
        </div>
      ) : null}

      {repositoryUnavailable ? (
        <section className="workspace-repository-unavailable" role="alert">
          <GitBranch />
          <div>
            <b>{t("workbench.repositoryUnavailable")}</b>
            <p>{repositoryUnavailable}</p>
            <p>{t("workbench.repositoryUnavailableDescription")}</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/">{t("workbench.backToProjects")}</Link>
          </Button>
        </section>
      ) : (
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
                      aria-label={t("workbench.createFile")}
                      onClick={() => setOperation({ mode: "create", path: "" })}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <FilePlus2 />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("workbench.createFile")}</TooltipContent>
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
                            aria-label={t("workbench.formatFile")}
                            disabled={!activeFile}
                            onClick={formatActiveFile}
                            size="icon-sm"
                            variant="ghost"
                          >
                            <WandSparkles />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("workbench.formatFile")}
                        </TooltipContent>
                      </Tooltip>
                      <Button
                        disabled={
                          !activeFile?.dirty || state.saveStatus === "saving"
                        }
                        onClick={saveActiveFile}
                        size="sm"
                      >
                        <Save data-icon="inline-start" />
                        {state.saveStatus === "saving"
                          ? t("workbench.saving")
                          : t("workbench.save")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="preview-heading">
                    <span>{t("workbench.livePreview")}</span>
                    <small>r{Math.max(state.revision, agentRevision)}</small>
                  </div>
                )}
              </div>

              <div className="ide-surface">
                <div
                  aria-hidden={view !== "code"}
                  className="ide-surface-panel ide-code-surface"
                  hidden={view !== "code"}
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
                        <span>{t("workbench.openFileHint")}</span>
                      </div>
                    )
                  ) : null}
                </div>

                <div
                  aria-hidden={view !== "preview"}
                  className="ide-surface-panel ide-preview-surface"
                  hidden={view !== "preview"}
                >
                  {/*
                   * Preview 必须常驻 DOM。Code/Preview 只是工作台视图切换，不应
                   * 销毁 iframe、Runtime Bridge 与页面内部状态，更不应让用户误以为
                   * 每次返回都要重新 mount/install。hidden 只控制可见性，不会卸载组件。
                   */}
                  <WebContainerPreview
                    clientToolRequest={
                      isPreviewClientToolRequest(clientToolRequest)
                        ? clientToolRequest
                        : null
                    }
                    files={repositoryFiles}
                    onClientToolResult={handleClientToolResult}
                    projectId={project.id}
                    revision={state.revision}
                  />
                </div>
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
                    localizedStatusMessage ||
                    (dirtyPaths.length > 0
                      ? t("workbench.unsavedFiles", {
                          count: dirtyPaths.length,
                        })
                      : t("workbench.repositoryRevision", {
                          revision: state.revision,
                        }))}
                </span>
                {activeFile ? <span>{activeFile.path}</span> : null}
              </footer>
            </div>
          </section>
        </div>
      )}

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

function formatWorkspaceStatusDetail(
  detail: WorkspaceStatusDetail,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (!detail) {
    return "";
  }

  switch (detail.kind) {
    case "saving":
      return t("workbench.savingRepository");
    case "saved":
      return t(
        detail.hasNewDraft
          ? "workbench.savedRevisionWithDraft"
          : "workbench.savedRevision",
        { revision: detail.revision },
      );
    case "created":
      return t("workbench.fileCreated", { path: detail.path });
    case "renamed":
      return t("workbench.fileRenamed", { path: detail.path });
    case "deleted":
      return t("workbench.fileDeleted", { path: detail.path });
  }
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
