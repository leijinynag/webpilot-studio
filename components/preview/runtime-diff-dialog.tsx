"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  FileCode2,
  FilePenLine,
  FilePlus2,
  GitCompareArrows,
  LoaderCircle,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getMonacoLanguage } from "@/components/workbench/code-editor";
import { loadLocalMonacoReact } from "@/components/workbench/monaco-client";
import type {
  RuntimeFileDiff,
  RuntimeFileDiffEntry,
} from "@/domains/project/types";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

const MonacoDiffEditor = dynamic(
  () => loadLocalMonacoReact().then((module) => module.DiffEditor),
  {
    ssr: false,
    loading: () => <RuntimeDiffEditorLoading />,
  },
);

export type RuntimeImportResult =
  | { status: "imported"; revision: number }
  | { status: "stale"; message: string }
  | { status: "failed"; message: string };

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export type RuntimeDiffDialogProps = {
  diff: RuntimeFileDiff | null;
  dirtyPaths: readonly string[];
  errorMessage: string | null;
  loading: boolean;
  onImport: (
    diff: RuntimeFileDiff,
    selectedEntries: readonly RuntimeFileDiffEntry[],
  ) => Promise<RuntimeImportResult>;
  onOpenChange: (open: boolean) => void;
  onRescan: () => void;
  open: boolean;
};

type MonacoTheme = "light" | "vs-dark";

export function RuntimeDiffDialog({
  diff,
  dirtyPaths,
  errorMessage,
  loading,
  onImport,
  onOpenChange,
  onRescan,
  open,
}: RuntimeDiffDialogProps) {
  const { t } = useUiI18n();
  const diffIdentity = useMemo(() => {
    if (!diff) {
      return "empty";
    }

    return [
      diff.projectKey,
      diff.baseRevision,
      diff.entries.map((entry) => `${entry.status}:${entry.path}`).join("|"),
    ].join(":");
  }, [diff]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="runtime-diff-dialog">
        <DialogHeader className="runtime-diff-header">
          <div>
            <span className="runtime-diff-eyebrow">
              <GitCompareArrows />
              {t("runtimeDiff.eyebrow")}
            </span>
            <DialogTitle>{t("runtimeDiff.title")}</DialogTitle>
          </div>
          <DialogDescription>{t("runtimeDiff.description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <RuntimeDiffState>
            <LoaderCircle className="animate-spin" />
            <span>{t("runtimeDiff.scanning")}</span>
          </RuntimeDiffState>
        ) : errorMessage ? (
          <RuntimeDiffState tone="error">
            <TriangleAlert />
            <span>{errorMessage}</span>
            <Button onClick={onRescan} size="sm" variant="outline">
              <RotateCw />
              {t("runtimeDiff.rescan")}
            </Button>
          </RuntimeDiffState>
        ) : diff && diff.entries.length > 0 ? (
          <RuntimeDiffReview
            dirtyPaths={dirtyPaths}
            diff={diff}
            key={diffIdentity}
            onImport={onImport}
            onOpenChange={onOpenChange}
            onRescan={onRescan}
          />
        ) : (
          <RuntimeDiffState>
            <FileCode2 />
            <span>{t("runtimeDiff.noChanges")}</span>
            <Button onClick={onRescan} size="sm" variant="outline">
              <RotateCw />
              {t("runtimeDiff.rescan")}
            </Button>
          </RuntimeDiffState>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuntimeDiffReview({
  diff,
  dirtyPaths,
  onImport,
  onOpenChange,
  onRescan,
}: {
  diff: RuntimeFileDiff;
  dirtyPaths: readonly string[];
  onImport: RuntimeDiffDialogProps["onImport"];
  onOpenChange: RuntimeDiffDialogProps["onOpenChange"];
  onRescan: RuntimeDiffDialogProps["onRescan"];
}) {
  const { t } = useUiI18n();
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(diff.entries.map((entry) => entry.path)),
  );
  const [activePath, setActivePath] = useState<string | null>(
    () => diff.entries[0]?.path ?? null,
  );
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const monacoTheme = useMonacoTheme();
  const entryByPath = useMemo(
    () => new Map(diff.entries.map((entry) => [entry.path, entry])),
    [diff],
  );
  const activeEntry = activePath ? entryByPath.get(activePath) ?? null : null;
  const selectedEntries = useMemo(
    () => diff.entries.filter((entry) => selectedPaths.has(entry.path)),
    [diff, selectedPaths],
  );
  const dirtyPathSet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const selectedDirtyPaths = selectedEntries
    .filter((entry) => dirtyPathSet.has(entry.path))
    .map((entry) => entry.path);
  const counts = countRuntimeDiffEntries(diff.entries);
  const canImport =
    selectedEntries.length > 0 &&
    selectedDirtyPaths.length === 0 &&
    !importing;

  function togglePath(path: string) {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
    setActivePath(path);
    setImportMessage(null);
  }

  async function submitImport() {
    if (!canImport) {
      return;
    }

    setImporting(true);
    setImportMessage(null);
    try {
      // 这里仅提交用户勾选的运行时差异；真正写入 Repository 时还会由上层用
      // baseRevision 做 CAS 校验，避免把过期运行镜像覆盖到较新的项目版本。
      const result = await onImport(diff, selectedEntries);
      if (result.status === "imported") {
        setImportMessage(
          t("runtimeDiff.imported", { revision: result.revision }),
        );
        onOpenChange(false);
      } else {
        // stale/failed 都不会修改本地选择，让用户能保留审查上下文再决定重扫或关闭。
        setImportMessage(result.message);
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <section className="runtime-diff-layout">
        <aside className="runtime-diff-sidebar">
          <header className="runtime-diff-summary">
            <Badge variant="outline">r{diff.baseRevision}</Badge>
            <span>{t("runtimeDiff.baseRevision")}</span>
            <small>
              {t("runtimeDiff.fileCount", { count: diff.entries.length })}
            </small>
          </header>

          <div className="runtime-diff-counts" aria-label="Runtime diff">
            <DiffCount label={t("runtimeDiff.added")} value={counts.added} />
            <DiffCount
              label={t("runtimeDiff.modified")}
              value={counts.modified}
            />
            <DiffCount label={t("runtimeDiff.deleted")} value={counts.deleted} />
          </div>

          <div className="runtime-diff-selection-actions">
            <Button
              onClick={() =>
                setSelectedPaths(
                  new Set(diff.entries.map((entry) => entry.path)),
                )
              }
              size="xs"
              type="button"
              variant="outline"
            >
              <Check />
              {t("runtimeDiff.selectAll")}
            </Button>
            <Button
              onClick={() => setSelectedPaths(new Set())}
              size="xs"
              type="button"
              variant="ghost"
            >
              {t("runtimeDiff.clearAll")}
            </Button>
          </div>

          <div className="runtime-diff-file-list">
            {diff.entries.map((entry) => (
              <button
                aria-pressed={activePath === entry.path}
                className={cn(
                  "runtime-diff-file",
                  activePath === entry.path && "is-active",
                  dirtyPathSet.has(entry.path) && "has-draft",
                )}
                key={`${entry.status}:${entry.path}`}
                onClick={() => togglePath(entry.path)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "runtime-diff-checkmark",
                    selectedPaths.has(entry.path) && "is-selected",
                  )}
                >
                  {selectedPaths.has(entry.path) ? <Check /> : null}
                </span>
                <RuntimeDiffStatusIcon status={entry.status} />
                <span title={entry.path}>{entry.path}</span>
                <Badge
                  className={cn(
                    "runtime-diff-status-badge",
                    `is-${entry.status}`,
                  )}
                  variant="outline"
                >
                  {runtimeDiffStatusLabel(entry.status, t)}
                </Badge>
              </button>
            ))}
          </div>

          <footer className="runtime-diff-drafts">
            <strong>{t("runtimeDiff.unsavedDrafts")}</strong>
            {selectedDirtyPaths.length > 0 ? (
              <>
                <p>{t("runtimeDiff.draftBlocked")}</p>
                <ul>
                  {selectedDirtyPaths.slice(0, 6).map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>{t("runtimeDiff.draftSafe")}</p>
            )}
          </footer>
        </aside>

        <main className="runtime-diff-main">
          {activeEntry ? (
            <RuntimeDiffEditor entry={activeEntry} theme={monacoTheme} />
          ) : (
            <RuntimeDiffState>
              <FileCode2 />
              <span>{t("runtimeDiff.noActiveFile")}</span>
            </RuntimeDiffState>
          )}
        </main>
      </section>

      {importMessage ? (
        <div className="runtime-diff-message" role="status">
          {importMessage}
        </div>
      ) : null}

      <DialogFooter className="runtime-diff-footer">
        <Button
          disabled={importing}
          onClick={onRescan}
          type="button"
          variant="outline"
        >
          <RotateCw />
          {t("runtimeDiff.rescan")}
        </Button>
        <Button disabled={!canImport} onClick={submitImport} type="button">
          {importing ? <LoaderCircle className="animate-spin" /> : <Check />}
          {importing
            ? t("runtimeDiff.importing")
            : t("runtimeDiff.importSelected", {
                count: selectedEntries.length,
              })}
        </Button>
      </DialogFooter>
    </>
  );
}

function RuntimeDiffEditor({
  entry,
  theme,
}: {
  entry: RuntimeFileDiffEntry;
  theme: MonacoTheme;
}) {
  const beforeContent = entry.beforeContent ?? "";
  const afterContent = entry.afterContent ?? "";

  return (
    <article className="runtime-diff-editor">
      <header>
        <div>
          <RuntimeDiffStatusIcon status={entry.status} />
          <strong>{entry.path}</strong>
        </div>
        <Badge
          className={cn("runtime-diff-status-badge", `is-${entry.status}`)}
          variant="outline"
        >
          <TranslatedStatus status={entry.status} />
        </Badge>
      </header>
      <div className="runtime-diff-editor-body">
        <MonacoDiffEditor
          language={getMonacoLanguage(entry.path)}
          modified={afterContent}
          original={beforeContent}
          options={{
            accessibilitySupport: "auto",
            automaticLayout: true,
            fontFamily:
              '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            originalEditable: false,
            readOnly: true,
            renderOverviewRuler: false,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            wordWrap: "on",
          }}
          theme={theme}
        />
      </div>
    </article>
  );
}

function RuntimeDiffState({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div className={cn("runtime-diff-state", tone === "error" && "is-error")}>
      {children}
    </div>
  );
}

function RuntimeDiffEditorLoading() {
  const { t } = useUiI18n();

  return (
    <div className="runtime-diff-editor-loading">
      <LoaderCircle className="animate-spin" />
      {t("runtimeDiff.loadEditor")}
    </div>
  );
}

function DiffCount({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <strong>{value}</strong>
      <small>{label}</small>
    </span>
  );
}

function RuntimeDiffStatusIcon({
  status,
}: {
  status: RuntimeFileDiffEntry["status"];
}) {
  if (status === "added") {
    return <FilePlus2 />;
  }
  if (status === "deleted") {
    return <Trash2 />;
  }
  return <FilePenLine />;
}

function countRuntimeDiffEntries(entries: readonly RuntimeFileDiffEntry[]) {
  return entries.reduce(
    (counts, entry) => {
      counts[entry.status] += 1;
      return counts;
    },
    { added: 0, modified: 0, deleted: 0 },
  );
}

function runtimeDiffStatusLabel(
  status: RuntimeFileDiffEntry["status"],
  translate: Translate,
) {
  return {
    added: translate("runtimeDiff.added"),
    modified: translate("runtimeDiff.modified"),
    deleted: translate("runtimeDiff.deleted"),
  }[status];
}

function TranslatedStatus({
  status,
}: {
  status: RuntimeFileDiffEntry["status"];
}) {
  const { t } = useUiI18n();

  return runtimeDiffStatusLabel(status, t);
}

function useMonacoTheme(): MonacoTheme {
  const [theme, setTheme] = useState<MonacoTheme>("light");

  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      setTheme(root.dataset.theme === "dark" ? "vs-dark" : "light");
    };

    applyTheme();
    const observer = new MutationObserver(applyTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}
