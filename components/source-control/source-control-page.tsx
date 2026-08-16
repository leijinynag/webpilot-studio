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
import { useUiI18n } from "@/infrastructure/i18n/ui";
import type { ProjectDescription } from "@/domains/project/types";

type DiffMode = "staged" | "working";

export function SourceControlPage({
  project,
}: {
  project: ProjectDescription;
}) {
  const { t } = useUiI18n();
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
  const [loading, setLoading] = useState(
    isBrowserGit && project.status !== "unavailable",
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    project.status === "unavailable"
      ? t("sourceControl.repositoryDataLost")
      : null,
  );
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(
    null,
  );

  const refresh = useCallback(async () => {
    if (!repository) {
      return;
    }

    // 服务端项目索引已经确认本地仓库丢失时，不再自动重复等待同一个 Worker
    // 恢复。用户仍可主动点击“重试恢复”，用于浏览器权限或存储只是暂时异常的情况。
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
          : t("sourceControl.repositoryRestoreFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [repository, t]);

  useEffect(() => {
    if (project.status === "unavailable") {
      return;
    }

    // 延后一帧启动 IndexedDB/Worker 恢复，避免 effect 执行阶段触发级联渲染。
    const task = window.setTimeout(() => {
      void refresh();
    }, 0);

    return () => window.clearTimeout(task);
  }, [project.status, refresh]);

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
          : t("sourceControl.sourceControlFailed"),
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
        <h1 className="font-editorial">{t("sourceControl.localFirstTitle")}</h1>
        <p>{t("sourceControl.databaseDescription")}</p>
        <Button asChild variant="outline">
          <Link href={`/p/${project.id}`}>
            {t("sourceControl.backToWorkbench")}
          </Link>
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
        <h1 className="font-editorial">{t("sourceControl.unavailable")}</h1>
        <p>{error}</p>
        <p>{t("sourceControl.unavailableDescription")}</p>
        <div className="source-unavailable-actions">
          <Button onClick={() => void refresh()} variant="outline">
            <RefreshCw data-icon="inline-start" />
            {t("sourceControl.retryRestore")}
          </Button>
          <Button asChild variant="ghost">
            <Link href="/">{t("sourceControl.backToProjects")}</Link>
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
            <b>{t("sourceControl.title")}</b>
            <span className="source-project-label">{project.name}</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("sourceControl.refreshChanges")}
                disabled={loading}
                onClick={() => void refresh()}
                size="icon-sm"
                variant="ghost"
              >
                <RefreshCw className={loading ? "source-spin" : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("sourceControl.refreshChanges")}</TooltipContent>
          </Tooltip>
        </div>

        <div className="source-repository-summary">
          <div>
            <span>{t("sourceControl.branch")}</span>
            <b>
              <GitBranch />
              {state?.branch ?? "main"}
            </b>
          </div>
          <div>
            <span>{t("sourceControl.revision")}</span>
            <b>r{state?.revision ?? project.revision}</b>
          </div>
        </div>

        <div className="source-local-warning">
          <Archive />
          <span>{t("sourceControl.localWarning")}</span>
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
            <span>{t("sourceControl.restoring")}</span>
          </div>
        ) : (
          <div className="file-groups">
            <ChangeGroup
              files={groups.staged}
              label={t("sourceControl.stagedChanges")}
              translate={t}
              onBulkAction={() =>
                void unstage(groups.staged.map((file) => file.path))
              }
              onFileAction={(path) => void unstage([path])}
              actionLabel={t("sourceControl.unstage")}
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
              label={t("sourceControl.changes")}
              translate={t}
              onBulkAction={() =>
                void stage(groups.unstaged.map((file) => file.path))
              }
              onFileAction={(path) => void stage([path])}
              actionLabel={t("sourceControl.stage")}
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
              label={t("sourceControl.untracked")}
              translate={t}
              onBulkAction={() =>
                void stage(groups.untracked.map((file) => file.path))
              }
              onFileAction={(path) => void stage([path])}
              actionLabel={t("sourceControl.stage")}
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
            <span>{t("sourceControl.workingTreeClean")}</span>
          </div>
        ) : null}
      </aside>

      <section className="source-diff">
        <div className="diff-header">
          <div>
            <b>{selectedFile?.path ?? t("sourceControl.noFileSelected")}</b>
            {selectedFile ? (
              <span className="diff-context">
                {diffMode === "staged"
                  ? t("sourceControl.stagedDiff")
                  : t("sourceControl.workingDiff")}
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
              {t("sourceControl.staged")}
            </Button>
            <Button
              className="diff-mode-button"
              disabled={!selectedFile?.unstaged}
              onClick={() => setDiffMode("working")}
              size="xs"
              variant={diffMode === "working" ? "secondary" : "ghost"}
            >
              {t("sourceControl.workingTree")}
            </Button>
          </div>
        </div>
        {selectedFile ? (
          <DiffView file={selectedFile} mode={diffMode} />
        ) : (
          <div className="source-diff-empty">
            <FileCode2 />
            <span>{t("sourceControl.selectFile")}</span>
          </div>
        )}
      </section>

      <aside className="source-commit">
        <div className="source-commit-topline">
          <div>
            <span className="source-kicker">
              {t("sourceControl.repositoryStatus")}
            </span>
            <strong>
              {t("sourceControl.changed", { count: changedCount })}
            </strong>
          </div>
          <Button
            aria-label={t("sourceControl.exportBackup")}
            disabled={pendingAction !== null}
            onClick={() => void exportBackup()}
            size="icon-sm"
            variant="outline"
          >
            <Download />
          </Button>
        </div>
        <h2 className="font-editorial">{t("sourceControl.commitChanges")}</h2>
        <p>{t("sourceControl.commitHint")}</p>
        <label className="field-label" htmlFor="commit-message">
          {t("sourceControl.message")}
        </label>
        <textarea
          className="field"
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder={t("sourceControl.messagePlaceholder")}
          value={commitMessage}
        />
        <div className="commit-summary">
          <div className="summary-cell">
            <b>{stagedCount}</b>
            <span>{t("sourceControl.stagedCount")}</span>
          </div>
          <div className="summary-cell">
            <b>+{sumChanges(stagedFiles, "additions")}</b>
            <span>{t("sourceControl.added")}</span>
          </div>
          <div className="summary-cell">
            <b>-{sumChanges(stagedFiles, "deletions")}</b>
            <span>{t("sourceControl.removed")}</span>
          </div>
        </div>
        <div className="author-row">
          <div>
            <label className="field-label" htmlFor="author">
              {t("sourceControl.author")}
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
              {t("sourceControl.email")}
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
          {t("sourceControl.commitStaged")}
        </Button>

        <div className="history">
          <div className="history-heading">
            <h3>{t("sourceControl.history")}</h3>
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
            <span className="history-empty">
              {t("sourceControl.noCommits")}
            </span>
          )}
        </div>

        {selectedCommit ? (
          <div className="commit-detail">
            <span className="source-kicker">
              {t("sourceControl.selectedCommit")}
            </span>
            <b>{selectedCommit.message}</b>
            <span>
              {selectedCommit.author.name} &lt;{selectedCommit.author.email}&gt;
            </span>
            <code>{selectedCommit.oid}</code>
          </div>
        ) : null}

        <Link className="back-to-workbench" href={`/p/${project.id}`}>
          {t("sourceControl.backToWorkbench")}
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
  translate,
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
  translate: (key: string, values?: Record<string, string | number>) => string;
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
            aria-label={translate("sourceControl.stageAll", { label })}
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
