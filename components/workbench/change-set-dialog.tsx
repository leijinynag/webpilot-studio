"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  FileDiff,
  FilePenLine,
  Files,
  History,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
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
import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import type {
  ProjectChangeOperation,
  ProjectChangeSet,
  ProjectChangeSetFile,
  ProjectRestoreConflict,
  ProjectRestoreImpact,
  ProjectRestorePreview,
} from "@/domains/project/types";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

const MonacoDiffEditor = dynamic(
  () => loadLocalMonacoReact().then((module) => module.DiffEditor),
  {
    ssr: false,
    loading: () => <DiffEditorLoading />,
  },
);

type ChangeSetDialogProps = {
  runId: string;
  dirtyPaths: readonly string[];
  onOpenChange: (open: boolean) => void;
  onRestoreComplete: (revision: number) => Promise<void> | void;
};

type ChangeSetResponse = { changeSet: ProjectChangeSet };
type RestorePreviewResponse = { preview: ProjectRestorePreview };
type RestoreResponse = { result: { revision: number } };
type ApiErrorResponse = {
  error?: {
    code?: string;
    message?: string;
    details?: {
      actualRevision?: number;
      expectedRevision?: number;
    };
  };
};

type MonacoTheme = "light" | "vs-dark";
type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export function ChangeSetDialog({
  runId,
  dirtyPaths,
  onOpenChange,
  onRestoreComplete,
}: ChangeSetDialogProps) {
  const { t } = useUiI18n();
  const [changeSet, setChangeSet] = useState<ProjectChangeSet | null>(null);
  const [preview, setPreview] = useState<ProjectRestorePreview | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const monacoTheme = useMonacoTheme();

  const loadReview = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const review = await fetchChangeSetReview(runId, t);
      setChangeSet(review.changeSet);
      setPreview(review.preview);
      setSelectedFileId("all");
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("changeSet.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [runId, t]);

  useEffect(() => {
    let active = true;

    // 弹窗由父组件按 runId 独立挂载，因此初始状态天然属于当前 Run。
    // 请求完成前如果用户关闭弹窗，active 会阻止已卸载实例继续写入状态。
    void fetchChangeSetReview(runId, t)
      .then((review) => {
        if (!active) {
          return;
        }
        setChangeSet(review.changeSet);
        setPreview(review.preview);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setErrorMessage(
          error instanceof Error ? error.message : t("changeSet.loadFailed"),
        );
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [runId, t]);

  const selectedFiles = useMemo(() => {
    if (!changeSet) {
      return [];
    }
    return selectedFileId === "all"
      ? changeSet.files
      : changeSet.files.filter((file) => file.id === selectedFileId);
  }, [changeSet, selectedFileId]);

  async function restoreChangeSet() {
    if (!preview?.canRestore || restoring) {
      return;
    }

    setRestoring(true);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/agent-runs/${runId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: preview.currentRevision,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        RestoreResponse | ApiErrorResponse;

      if (!response.ok || !("result" in body)) {
        const errorBody = "error" in body ? body : {};
        const stale =
          errorBody.error?.code === PROJECT_ERROR_CODES.revisionConflict ||
          errorBody.error?.code === PROJECT_ERROR_CODES.restoreConflict;

        if (stale) {
          // 预检与提交之间发生 mutation 时，服务端会拒绝盲目覆盖。
          // 重新加载后用户能看到新的 revision 或具体冲突，而不是只得到泛化错误。
          await loadReview();
        }

        throw new Error(readApiError(body, t("changeSet.restoreFailed")));
      }

      await onRestoreComplete(body.result.revision);
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("changeSet.restoreRetry"),
      );
    } finally {
      setRestoring(false);
    }
  }

  const conflictPaths = new Set(
    preview?.conflicts.map((conflict) => conflict.path) ?? [],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent className="change-set-dialog">
        <DialogHeader className="change-set-header">
          <div>
            <span className="change-set-eyebrow">
              <History />
              {t("changeSet.eyebrow")}
            </span>
            <DialogTitle>{t("changeSet.title")}</DialogTitle>
          </div>
          <DialogDescription>{t("changeSet.description")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="change-set-state">
            <LoaderCircle className="animate-spin" />
            <span>{t("changeSet.loading")}</span>
          </div>
        ) : changeSet && preview ? (
          <div className="change-set-layout">
            <aside className="change-set-sidebar">
              <div className="change-set-summary">
                <span>r{changeSet.baseRevision}</span>
                <ArrowRight />
                <span>r{changeSet.resultRevision}</span>
                <strong>{changeSet.summary}</strong>
              </div>

              <div className="change-set-file-list">
                <button
                  className={cn(
                    "change-set-file",
                    selectedFileId === "all" && "is-active",
                  )}
                  onClick={() => setSelectedFileId("all")}
                  type="button"
                >
                  <Files />
                  <span>{t("changeSet.allFiles")}</span>
                  <small>{changeSet.files.length}</small>
                </button>
                {changeSet.files.map((file) => (
                  <button
                    className={cn(
                      "change-set-file",
                      selectedFileId === file.id && "is-active",
                    )}
                    key={file.id}
                    onClick={() => setSelectedFileId(file.id)}
                    type="button"
                  >
                    <FileDiff />
                    <span>{getDisplayPath(file, t)}</span>
                    <OperationBadge operation={file.operation} />
                  </button>
                ))}
              </div>

              <section className="change-set-drafts">
                <header>
                  <FilePenLine />
                  <strong>{t("changeSet.unsavedDrafts")}</strong>
                  <small>{dirtyPaths.length}</small>
                </header>
                {dirtyPaths.length ? (
                  <>
                    <p>{t("changeSet.draftHint")}</p>
                    <ul>
                      {dirtyPaths.map((path) => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p>{t("changeSet.noDrafts")}</p>
                )}
              </section>
            </aside>

            <main className="change-set-main">
              <div className="change-set-diffs">
                {selectedFiles.length ? (
                  selectedFiles.map((file) => (
                    <ChangeDiff key={file.id} file={file} theme={monacoTheme} />
                  ))
                ) : (
                  <div className="change-set-empty">
                    <Check />
                    {t("changeSet.noChanges")}
                  </div>
                )}
              </div>

              <RestorePreview conflictPaths={conflictPaths} preview={preview} />
            </main>
          </div>
        ) : (
          <div className="change-set-state is-error">
            <TriangleAlert />
            <span>{errorMessage ?? t("changeSet.noChangeSet")}</span>
            <Button
              onClick={() => void loadReview()}
              size="sm"
              variant="outline"
            >
              {t("changeSet.retry")}
            </Button>
          </div>
        )}

        {errorMessage && changeSet && preview ? (
          <div className="change-set-inline-error" role="alert">
            <TriangleAlert />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <DialogFooter className="change-set-footer">
          <div
            className={cn(
              "change-set-restore-copy",
              preview && !preview.canRestore && "is-blocked",
            )}
          >
            {preview?.canRestore ? <Check /> : <ShieldAlert />}
            <span>
              {preview?.canRestore
                ? t("changeSet.restoreBasedOn", {
                    revision: preview.currentRevision,
                  })
                : preview
                  ? t("changeSet.restoreLocked")
                  : t("changeSet.restorePending")}
            </span>
          </div>
          <Button
            disabled={!preview?.canRestore || loading || restoring}
            onClick={() => void restoreChangeSet()}
            variant="destructive"
          >
            {restoring ? (
              <LoaderCircle className="animate-spin" data-icon="inline-start" />
            ) : (
              <RotateCcw data-icon="inline-start" />
            )}
            {restoring ? t("changeSet.restoring") : t("changeSet.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeDiff({
  file,
  theme,
}: {
  file: ProjectChangeSetFile;
  theme: MonacoTheme;
}) {
  const { t } = useUiI18n();
  const path = file.pathAfter ?? file.pathBefore ?? "untitled";
  const lineCount = Math.max(
    countLines(file.beforeContent),
    countLines(file.afterContent),
  );
  const height = Math.min(420, Math.max(190, lineCount * 20 + 76));

  return (
    <article className="change-set-diff">
      <header>
        <div>
          <OperationBadge operation={file.operation} />
          <strong>{getDisplayPath(file, t)}</strong>
        </div>
        <small>{formatHashTransition(file, t)}</small>
      </header>
      <div className="change-set-diff-editor" style={{ height }}>
        <MonacoDiffEditor
          height="100%"
          keepCurrentModifiedModel
          keepCurrentOriginalModel
          language={getMonacoLanguage(path)}
          modified={file.afterContent ?? ""}
          onMount={(editor) => {
            const model = editor.getModel();

            // @monaco-editor/react 4.7 默认先 dispose TextModel，再 dispose
            // DiffEditor；Monaco 0.52 会把这个顺序识别为内部一致性错误。
            // 交给编辑器先完成解绑，随后再释放两个只读模型，既不会产生
            // 控制台异常，也不会在反复打开 ChangeSet 时积累模型。
            editor.onDidDispose(() => {
              model?.original.dispose();
              model?.modified.dispose();
            });
          }}
          original={file.beforeContent ?? ""}
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

function DiffEditorLoading() {
  const { t } = useUiI18n();

  return (
    <div className="change-set-diff-loading">
      <LoaderCircle className="animate-spin" />
      {t("changeSet.loadEditor")}
    </div>
  );
}

function useMonacoTheme(): MonacoTheme {
  const [theme, setTheme] = useState<MonacoTheme>("light");

  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      setTheme(root.dataset.theme === "dark" ? "vs-dark" : "light");
    };

    applyTheme();

    // 全局主题只修改 html[data-theme]。监听属性而不重建 DiffEditor，
    // 可以保留用户的滚动位置，同时让弹窗内所有 diff 即时切换明暗配色。
    const observer = new MutationObserver(applyTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}

function RestorePreview({
  preview,
  conflictPaths,
}: {
  preview: ProjectRestorePreview;
  conflictPaths: ReadonlySet<string>;
}) {
  const { t } = useUiI18n();

  return (
    <section className="restore-preview">
      <header>
        <div>
          <strong>{t("changeSet.restorePreview")}</strong>
          <span>
            {t("changeSet.currentRepository", {
              revision: preview.currentRevision,
            })}
          </span>
        </div>
        <Badge variant={preview.canRestore ? "outline" : "destructive"}>
          {preview.canRestore
            ? t("changeSet.pathsWillChange", {
                count: countEffectiveImpacts(preview.impacts),
              })
            : t("changeSet.conflicts", {
                count: preview.conflicts.length,
              })}
        </Badge>
      </header>

      {preview.conflicts.length ? (
        <div className="restore-conflicts">
          <p>{t("changeSet.conflictDescription")}</p>
          {preview.conflicts.map((conflict) => (
            <RestoreConflictRow conflict={conflict} key={conflict.path} />
          ))}
        </div>
      ) : null}

      <div className="restore-impact-list">
        {preview.impacts.map((impact) => (
          <div
            className={cn(
              "restore-impact",
              conflictPaths.has(impact.path) && "is-conflict",
            )}
            key={impact.path}
          >
            <span>{impact.path}</span>
            <small>{getImpactLabel(impact, t)}</small>
          </div>
        ))}
        {!preview.impacts.length ? (
          <p className="change-set-empty">{t("changeSet.noRestoreFiles")}</p>
        ) : null}
      </div>
    </section>
  );
}

function RestoreConflictRow({
  conflict,
}: {
  conflict: ProjectRestoreConflict;
}) {
  const { t } = useUiI18n();
  const labels: Record<ProjectRestoreConflict["reason"], string> = {
    modified: t("changeSet.conflictModified"),
    created: t("changeSet.conflictCreated"),
    deleted: t("changeSet.conflictDeleted"),
  };

  return (
    <div className="restore-conflict">
      <TriangleAlert />
      <span>{conflict.path}</span>
      <small>{labels[conflict.reason]}</small>
    </div>
  );
}

function OperationBadge({ operation }: { operation: ProjectChangeOperation }) {
  const { t } = useUiI18n();
  const copy: Record<
    ProjectChangeOperation,
    { label: string; className: string }
  > = {
    create: { label: t("changeSet.operationCreate"), className: "is-create" },
    update: { label: t("changeSet.operationUpdate"), className: "is-update" },
    delete: { label: t("changeSet.operationDelete"), className: "is-delete" },
    rename: { label: t("changeSet.operationRename"), className: "is-rename" },
  };

  return (
    <Badge
      className={cn("change-operation-badge", copy[operation].className)}
      variant="outline"
    >
      {copy[operation].label}
    </Badge>
  );
}

function getDisplayPath(
  file: ProjectChangeSetFile,
  translate: Translate,
): string {
  if (
    file.operation === "rename" &&
    file.pathBefore &&
    file.pathAfter &&
    file.pathBefore !== file.pathAfter
  ) {
    return `${file.pathBefore} → ${file.pathAfter}`;
  }

  return (
    file.pathAfter ?? file.pathBefore ?? translate("changeSet.unknownPath")
  );
}

function formatHashTransition(
  file: ProjectChangeSetFile,
  translate: Translate,
): string {
  return `${shortHash(file.beforeHash, translate)} → ${shortHash(
    file.afterHash,
    translate,
  )}`;
}

function shortHash(hash: string | null, translate: Translate): string {
  return hash ? hash.slice(0, 8) : translate("changeSet.emptyHash");
}

function countLines(content: string | null): number {
  return content ? content.split("\n").length : 1;
}

function countEffectiveImpacts(
  impacts: readonly ProjectRestoreImpact[],
): number {
  return impacts.filter((impact) => impact.action !== "none").length;
}

function getImpactLabel(
  impact: ProjectRestoreImpact,
  translate: Translate,
): string {
  if (impact.action === "none") {
    return translate("changeSet.impactNone");
  }
  return impact.action === "write"
    ? translate("changeSet.impactWrite")
    : translate("changeSet.impactDelete");
}

function readApiError(
  body: ChangeSetResponse | RestorePreviewResponse | ApiErrorResponse | object,
  fallback: string,
): string {
  return "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
    ? body.error.message
    : fallback;
}

async function fetchChangeSetReview(
  runId: string,
  translate: Translate,
): Promise<{ changeSet: ProjectChangeSet; preview: ProjectRestorePreview }> {
  // 两个查询互不依赖：ChangeSet 负责展示历史正文，preview 负责读取
  // 当前 Repository 状态。并行请求可以避免弹窗先后闪烁两次。
  const [changeSetResponse, previewResponse] = await Promise.all([
    fetch(`/api/agent-runs/${runId}/change-set`, { cache: "no-store" }),
    fetch(`/api/agent-runs/${runId}/restore-preview`, {
      cache: "no-store",
    }),
  ]);
  const changeSetBody = (await changeSetResponse.json().catch(() => ({}))) as
    ChangeSetResponse | ApiErrorResponse;
  const previewBody = (await previewResponse.json().catch(() => ({}))) as
    RestorePreviewResponse | ApiErrorResponse;

  if (!changeSetResponse.ok || !("changeSet" in changeSetBody)) {
    throw new Error(
      readApiError(changeSetBody, translate("changeSet.readChangesFailed")),
    );
  }
  if (!previewResponse.ok || !("preview" in previewBody)) {
    throw new Error(
      readApiError(previewBody, translate("changeSet.computeRestoreFailed")),
    );
  }

  return {
    changeSet: changeSetBody.changeSet,
    preview: previewBody.preview,
  };
}
