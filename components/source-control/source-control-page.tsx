"use client";

import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  Download,
  FileCode2,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  BrowserGitProjectRepository,
  formatCommitShortOid,
  getChangedFileContent,
  groupBrowserGitChanges,
} from "@/domains/project/browser-git-repository";
import type {
  BrowserGitChangedFile,
  BrowserGitRepositoryState,
} from "@/infrastructure/browser-git/protocol";
import type { ProjectDescription } from "@/domains/project/types";

type DiffMode = "staged" | "working";

export function SourceControlPage({
  project,
}: {
  project: ProjectDescription;
}) {
  const isBrowserGit = project.storageKind === "browser_git";
  const repository = useMemo(
    () => (isBrowserGit ? new BrowserGitProjectRepository(project) : null),
    [isBrowserGit, project],
  );
  const [state, setState] = useState<BrowserGitRepositoryState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("working");
  const [commitMessage, setCommitMessage] = useState("");
  const [authorName, setAuthorName] = useState("Guest Builder");
  const [authorEmail, setAuthorEmail] = useState("guest@local");
  const [loading, setLoading] = useState(isBrowserGit);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (!repository) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await repository.initialize();
      const nextState = await repository.getGitState();
      setState(nextState);
      setSelectedPath((current) =>
        current && nextState.files.some((file) => file.path === current)
          ? current
          : (nextState.files[0]?.path ?? null),
      );
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Browser Git 仓库无法恢复。",
      );
    } finally {
      setLoading(false);
    }
  }, [repository]);

  useEffect(() => {
    // 延后一帧启动 IndexedDB/Worker 恢复，避免 effect 执行阶段触发级联渲染。
    const task = window.setTimeout(() => {
      void refresh();
    }, 0);

    return () => window.clearTimeout(task);
  }, [refresh]);

  const groups = useMemo(
    () => groupBrowserGitChanges(state?.files ?? []),
    [state?.files],
  );
  const selectedFile =
    state?.files.find((file) => file.path === selectedPath) ?? null;
  const selectedCommit =
    state?.commits.find((commit) => commit.oid === selectedCommitOid) ??
    state?.commits[0] ??
    null;
  const stagedFiles = groups.staged;
  const stagedCount = stagedFiles.length;
  const changedCount =
    groups.staged.length + groups.unstaged.length + groups.untracked.length;

  async function stage(paths: readonly string[]) {
    if (!repository || paths.length === 0) {
      return;
    }

    await runAction(`stage:${paths.join(",")}`, async () => {
      setState(await repository.stage(paths));
    });
  }

  async function unstage(paths: readonly string[]) {
    if (!repository || paths.length === 0) {
      return;
    }

    await runAction(`unstage:${paths.join(",")}`, async () => {
      setState(await repository.unstage(paths));
    });
  }

  async function commit() {
    if (!repository) {
      return;
    }

    await runAction("commit", async () => {
      const result = await repository.commit({
        message: commitMessage,
        authorName,
        authorEmail,
      });
      setState(result.state);
      setCommitMessage("");
      setSelectedCommitOid(result.oid);
      setSelectedPath(null);
    });
  }

  async function runAction(name: string, action: () => Promise<void>) {
    setPendingAction(name);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Source Control 操作失败。",
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function exportBackup() {
    if (!repository) {
      return;
    }

    await runAction("export", async () => {
      const backup = await repository.export();
      const blob = new Blob([backup.archive], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${project.name.replace(/\s+/g, "-")}-browser-git-backup.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  if (!isBrowserGit) {
    return (
      <div className="source-empty page-in">
        <GitBranch />
        <h1 className="font-editorial">Source Control is local-first.</h1>
        <p>
          当前项目使用 Database Repository。Browser Git 项目才会在当前浏览器中
          提供 stage、commit、历史和备份导出。
        </p>
        <Button asChild variant="outline">
          <Link href={`/p/${project.id}`}>返回 Agent 工作台</Link>
        </Button>
      </div>
    );
  }

  // 首次恢复失败时没有任何可信的 Git 状态，不能继续展示空白提交面板。
  // 这里保持“失败即显式不可用”的边界，避免用户误以为仓库被恢复成了空项目。
  if (!loading && error && !state) {
    return (
      <div className="source-empty source-unavailable page-in" role="alert">
        <AlertTriangle />
        <h1 className="font-editorial">本地仓库不可用</h1>
        <p>{error}</p>
        <p>
          WebPilot Studio 不会自动创建空仓库覆盖原项目。若只是浏览器临时故障，
          可以重试恢复；若站点数据已被清理，请返回项目列表处理该项目。
        </p>
        <div className="source-unavailable-actions">
          <Button onClick={() => void refresh()} variant="outline">
            <RefreshCw data-icon="inline-start" />
            重试恢复
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">返回项目列表</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="source-page page-in">
      <aside className="source-sidebar">
        <div className="source-heading">
          <div>
            <b>Source Control</b>
            <span className="source-project-label">{project.name}</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="刷新变更"
                disabled={loading}
                onClick={() => void refresh()}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCw className={loading ? "source-spin" : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新变更</TooltipContent>
          </Tooltip>
        </div>

        <div className="source-repository-summary">
          <div>
            <span>Branch</span>
            <b>
              <GitBranch />
              {state?.branch ?? "main"}
            </b>
          </div>
          <div>
            <span>Revision</span>
            <b>r{state?.revision ?? project.revision}</b>
          </div>
        </div>

        <div className="source-local-warning">
          <Archive />
          <span>仅保存在当前浏览器。清理站点数据前请先导出备份。</span>
        </div>

        {error ? (
          <div className="source-error" role="alert">
            <X />
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="source-loading" role="status">
            <LoaderCircle className="source-spin" />
            <span>正在恢复本地仓库...</span>
          </div>
        ) : (
          <div className="file-groups">
            <ChangeGroup
              files={groups.staged}
              label="Staged changes"
              onBulkAction={() =>
                void unstage(groups.staged.map((file) => file.path))
              }
              onFileAction={(path) => void unstage([path])}
              actionLabel="取消暂存"
              actionIcon={<Upload />}
              selectedPath={selectedPath}
              onSelect={(path) => {
                setSelectedPath(path);
                setDiffMode("staged");
              }}
              pendingAction={pendingAction}
            />
            <ChangeGroup
              files={groups.unstaged}
              label="Changes"
              onBulkAction={() =>
                void stage(groups.unstaged.map((file) => file.path))
              }
              onFileAction={(path) => void stage([path])}
              actionLabel="暂存"
              actionIcon={<Check />}
              selectedPath={selectedPath}
              onSelect={(path) => {
                setSelectedPath(path);
                setDiffMode("working");
              }}
              pendingAction={pendingAction}
            />
            <ChangeGroup
              files={groups.untracked}
              label="Untracked"
              onBulkAction={() =>
                void stage(groups.untracked.map((file) => file.path))
              }
              onFileAction={(path) => void stage([path])}
              actionLabel="暂存"
              actionIcon={<Check />}
              selectedPath={selectedPath}
              onSelect={(path) => {
                setSelectedPath(path);
                setDiffMode("working");
              }}
              pendingAction={pendingAction}
            />
          </div>
        )}

        {!loading && changedCount === 0 ? (
          <div className="source-clean">
            <Check />
            <span>Working tree clean</span>
          </div>
        ) : null}
      </aside>

      <section className="source-diff">
        <div className="diff-header">
          <div>
            <b>{selectedFile?.path ?? "No file selected"}</b>
            {selectedFile ? (
              <span className="diff-context">
                {diffMode === "staged" ? "Staged diff" : "Working tree diff"}
              </span>
            ) : null}
          </div>
          <div className="diff-actions">
            <Button
              className="diff-mode-button"
              disabled={!selectedFile?.staged}
              onClick={() => setDiffMode("staged")}
              size="xs"
              variant={diffMode === "staged" ? "secondary" : "ghost"}
            >
              Staged
            </Button>
            <Button
              className="diff-mode-button"
              disabled={!selectedFile?.unstaged}
              onClick={() => setDiffMode("working")}
              size="xs"
              variant={diffMode === "working" ? "secondary" : "ghost"}
            >
              Working tree
            </Button>
          </div>
        </div>
        {selectedFile ? (
          <DiffView file={selectedFile} mode={diffMode} />
        ) : (
          <div className="source-diff-empty">
            <FileCode2 />
            <span>选择一个文件查看差异</span>
          </div>
        )}
      </section>

      <aside className="source-commit">
        <div className="source-commit-topline">
          <div>
            <span className="source-kicker">Repository status</span>
            <strong>{changedCount} changed</strong>
          </div>
          <Button
            aria-label="导出 Browser Git 备份"
            disabled={pendingAction !== null}
            onClick={() => void exportBackup()}
            size="icon-sm"
            variant="outline"
          >
            <Download />
          </Button>
        </div>
        <h2 className="font-editorial">Commit changes</h2>
        <p>只提交已经暂存并检查过的内容。Agent 不会自动创建 commit。</p>
        <label className="field-label" htmlFor="commit-message">
          Message
        </label>
        <textarea
          className="field"
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Describe this change..."
          value={commitMessage}
        />
        <div className="commit-summary">
          <div className="summary-cell">
            <b>{stagedCount}</b>
            <span>staged</span>
          </div>
          <div className="summary-cell">
            <b>+{sumChanges(stagedFiles, "additions")}</b>
            <span>added</span>
          </div>
          <div className="summary-cell">
            <b>-{sumChanges(stagedFiles, "deletions")}</b>
            <span>removed</span>
          </div>
        </div>
        <div className="author-row">
          <div>
            <label className="field-label" htmlFor="author">
              Author
            </label>
            <input
              className="field"
              id="author"
              onChange={(event) => setAuthorName(event.target.value)}
              value={authorName}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              className="field"
              id="email"
              onChange={(event) => setAuthorEmail(event.target.value)}
              value={authorEmail}
            />
          </div>
        </div>
        <Button
          className="commit-button app-button-accent"
          disabled={
            stagedCount === 0 || !commitMessage.trim() || pendingAction !== null
          }
          onClick={() => void commit()}
          size="sm"
        >
          {pendingAction === "commit" ? (
            <LoaderCircle className="source-spin" />
          ) : (
            <GitBranch data-icon="inline-start" />
          )}
          Commit staged changes
        </Button>

        <div className="history">
          <div className="history-heading">
            <h3>History</h3>
            <span>{state?.commits.length ?? 0}</span>
          </div>
          {state?.commits.length ? (
            state.commits.map((commit) => (
              <button
                className={`commit-item ${
                  selectedCommit?.oid === commit.oid ? "active" : ""
                }`}
                key={commit.oid}
                onClick={() => setSelectedCommitOid(commit.oid)}
                type="button"
              >
                <span className="commit-node" />
                <span>
                  <b>{commit.message}</b>
                  <small>
                    {formatCommitShortOid(commit)} · {commit.author.name}
                  </small>
                </span>
                <ChevronRight />
              </button>
            ))
          ) : (
            <span className="history-empty">还没有 commit。</span>
          )}
        </div>

        {selectedCommit ? (
          <div className="commit-detail">
            <span className="source-kicker">Selected commit</span>
            <b>{selectedCommit.message}</b>
            <span>
              {selectedCommit.author.name} &lt;{selectedCommit.author.email}&gt;
            </span>
            <code>{selectedCommit.oid}</code>
          </div>
        ) : null}

        <Link className="back-to-workbench" href={`/p/${project.id}`}>
          返回 Agent 工作台
        </Link>
      </aside>
    </div>
  );
}

function ChangeGroup({
  actionIcon,
  actionLabel,
  files,
  label,
  onBulkAction,
  onFileAction,
  onSelect,
  pendingAction,
  selectedPath,
}: {
  actionIcon: React.ReactNode;
  actionLabel: string;
  files: readonly BrowserGitChangedFile[];
  label: string;
  onBulkAction: () => void;
  onFileAction: (path: string) => void;
  onSelect: (path: string) => void;
  pendingAction: string | null;
  selectedPath: string | null;
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="change-group-title">
        <span>{label}</span>
        <div>
          <Badge variant="outline">{files.length}</Badge>
          <button
            aria-label={`${actionLabel}全部${label}`}
            className="group-action"
            disabled={pendingAction !== null}
            onClick={onBulkAction}
            type="button"
          >
            {actionIcon}
          </button>
        </div>
      </div>
      {files.map((file) => (
        <div
          className={`file-change ${
            selectedPath === file.path ? "active" : ""
          }`}
          key={file.path}
        >
          <button
            className="file-change-main"
            onClick={() => onSelect(file.path)}
            type="button"
          >
            <Square />
            <span>{file.path}</span>
            <span className={`file-status ${file.status}`}>
              {file.status === "untracked" ? "U" : "M"}
            </span>
          </button>
          <button
            aria-label={`${actionLabel} ${file.path}`}
            className="file-change-action"
            disabled={pendingAction !== null}
            onClick={() => onFileAction(file.path)}
            type="button"
          >
            {actionIcon}
          </button>
        </div>
      ))}
    </div>
  );
}

function DiffView({
  file,
  mode,
}: {
  file: BrowserGitChangedFile;
  mode: DiffMode;
}) {
  const content = getChangedFileContent(file, mode);
  const oldLines = splitLines(content.before);
  const newLines = splitLines(content.after);
  const lines = buildDiffLines(oldLines, newLines);

  return (
    <div className="code-diff">
      {lines.map((line, index) => (
        <div className={`code-line ${line.kind}`} key={`${index}-${line.text}`}>
          <span className="ln old">{line.oldLine ?? ""}</span>
          <span className="ln">{line.newLine ?? ""}</span>
          <span>{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function buildDiffLines(oldLines: string[], newLines: string[]) {
  const sharedPrefix = findSharedPrefix(oldLines, newLines);
  const sharedSuffix = findSharedSuffix(oldLines, newLines, sharedPrefix);
  const result: Array<{
    oldLine: number | null;
    newLine: number | null;
    text: string;
    kind: "normal" | "add" | "del";
  }> = [];
  const oldMiddle = oldLines.slice(
    sharedPrefix,
    oldLines.length - sharedSuffix,
  );
  const newMiddle = newLines.slice(
    sharedPrefix,
    newLines.length - sharedSuffix,
  );

  for (let index = 0; index < sharedPrefix; index += 1) {
    result.push({
      oldLine: index + 1,
      newLine: index + 1,
      text: oldLines[index] ?? "",
      kind: "normal",
    });
  }
  for (let index = 0; index < oldMiddle.length; index += 1) {
    result.push({
      oldLine: sharedPrefix + index + 1,
      newLine: null,
      text: `- ${oldMiddle[index] ?? ""}`,
      kind: "del",
    });
  }
  for (let index = 0; index < newMiddle.length; index += 1) {
    result.push({
      oldLine: null,
      newLine: sharedPrefix + index + 1,
      text: `+ ${newMiddle[index] ?? ""}`,
      kind: "add",
    });
  }
  for (let index = 0; index < sharedSuffix; index += 1) {
    const oldLine = oldLines.length - sharedSuffix + index + 1;
    const newLine = newLines.length - sharedSuffix + index + 1;
    result.push({
      oldLine,
      newLine,
      text: oldLines[oldLines.length - sharedSuffix + index] ?? "",
      kind: "normal",
    });
  }

  return result;
}

function findSharedPrefix(oldLines: string[], newLines: string[]) {
  let index = 0;
  while (index < oldLines.length && index < newLines.length) {
    if (oldLines[index] !== newLines[index]) {
      break;
    }
    index += 1;
  }
  return index;
}

function findSharedSuffix(
  oldLines: string[],
  newLines: string[],
  prefix: number,
) {
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] ===
      newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return suffix;
}

function splitLines(content: string | null) {
  return content ? content.replace(/\n$/, "").split("\n") : [];
}

function sumChanges(
  files: readonly BrowserGitChangedFile[],
  key: "additions" | "deletions",
) {
  return files.reduce((total, file) => total + file[key], 0);
}
