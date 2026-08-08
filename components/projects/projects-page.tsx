"use client";

import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  Database,
  LoaderCircle,
  Plus,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { browserApiFetch } from "@/infrastructure/http/browser-api";
import { getLocalizedErrorMessage } from "@/infrastructure/i18n/error-messages";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProjectSummary } from "@/domains/project/types";

type ProjectListResponse = {
  projects: ProjectSummary[];
};

type ApiErrorResponse = {
  error?: {
    code?: string;
    message?: string;
  };
};

async function fetchProjects(locale: "zh" | "en"): Promise<ProjectSummary[]> {
  const response = await browserApiFetch("/api/projects?includeDeleted=true", {
    cache: "no-store",
  });
  const body = (await response.json()) as
    ProjectListResponse | ApiErrorResponse;

  if (!response.ok || !("projects" in body)) {
    throw new Error(readApiMessage(body, locale, "projects.loadFailed"));
  }

  return body.projects;
}

export function ProjectsPage() {
  const { locale, t } = useUiI18n();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<ProjectSummary | null>(
    null,
  );
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // 请求包含软删除数据，首页才能在刷新后继续提供恢复入口。
      setProjects(await fetchProjects(locale));
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("projects.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [locale, t]);

  useEffect(() => {
    let cancelled = false;

    // 首屏 effect 只等待外部请求结果，不在 effect 主体同步切换 state，
    // 这样 React 不会为了 loading 状态再触发一轮级联渲染。
    void fetchProjects(locale)
      .then((loadedProjects) => {
        if (!cancelled) {
          setProjects(loadedProjects);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : t("projects.loadFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locale, t]);

  const activeProjects = useMemo(
    () => projects.filter((project) => project.deletedAt === null),
    [projects],
  );
  const deletedProjects = useMemo(
    () => projects.filter((project) => project.deletedAt !== null),
    [projects],
  );

  async function mutateProject(
    project: ProjectSummary,
    action: "delete" | "restore",
  ) {
    setPendingProjectId(project.id);
    setError(null);

    try {
      const response = await browserApiFetch(
        `/api/projects/${project.id}/${action}`,
        {
          method: "POST",
        },
      );
      const body = (await response.json()) as ApiErrorResponse;

      if (!response.ok) {
        throw new Error(
          readApiMessage(
            body,
            locale,
            action === "delete"
              ? "projects.operationFailed"
              : "projects.restoreFailed",
          ),
        );
      }

      setProjectToDelete(null);
      await loadProjects();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : t("projects.operationFailed"),
      );
    } finally {
      setPendingProjectId(null);
    }
  }

  return (
    <div className="projects-page page-in">
      <section className="projects-main">
        <div className="projects-hero">
          <div>
            <div className="eyebrow">{t("projects.eyebrow")}</div>
            <h1 className="font-editorial projects-title">
              {t("projects.title")
                .split("\n")
                .map((line) => (
                  <span key={line}>
                    {line}
                    <br />
                  </span>
                ))}
            </h1>
            <p className="projects-lede">{t("projects.lede")}</p>
          </div>
          <Button asChild size="lg">
            <Link href="/new">
              <Plus data-icon="inline-start" />
              {t("projects.newProject")}
            </Link>
          </Button>
        </div>

        <div className="start-composer panel">
          <textarea
            aria-label={t("projects.composerLabel")}
            className="composer-input"
            placeholder={t("projects.composerPlaceholder")}
          />
          <div className="composer-actions">
            <div className="composer-left">
              <Button disabled size="sm" variant="outline">
                <Plus data-icon="inline-start" />
                {t("projects.image")}
              </Button>
              <Button disabled size="sm" variant="outline">
                {t("projects.stack")}
              </Button>
            </div>
            <Button asChild className="app-button-accent" size="sm">
              <Link href="/new">
                {t("projects.startBuilding")}
                <Send data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="section-heading">
          <h2>{t("projects.recent")}</h2>
          <span>
            {t("projects.projectCount", { count: activeProjects.length })}
          </span>
        </div>

        {error ? (
          <div className="project-state project-state-error" role="alert">
            <AlertCircle />
            <div>
              <b>{t("projects.workspaceUnavailable")}</b>
              <span>{error}</span>
            </div>
            <Button
              onClick={() => void loadProjects()}
              size="sm"
              variant="outline"
            >
              <RotateCcw data-icon="inline-start" />
              {t("common.retry")}
            </Button>
          </div>
        ) : null}

        {loading ? (
          <div className="project-state" aria-live="polite">
            <LoaderCircle className="project-state-spinner" />
            <div>
              <b>{t("projects.loadingWorkspace")}</b>
              <span>{t("projects.restoringSession")}</span>
            </div>
          </div>
        ) : activeProjects.length > 0 ? (
          <div className="project-list">
            {activeProjects.map((project, index) => (
              <ProjectRow
                key={project.id}
                index={index}
                project={project}
                onDelete={() => setProjectToDelete(project)}
              />
            ))}
          </div>
        ) : (
          <div className="project-empty">
            <span className="project-empty-icon">
              <Database />
            </span>
            <h3 className="font-editorial">{t("projects.emptyTitle")}</h3>
            <p>{t("projects.emptyDescription")}</p>
            <Button asChild size="sm">
              <Link href="/new">
                <Plus data-icon="inline-start" />
                {t("projects.createProject")}
              </Link>
            </Button>
          </div>
        )}
      </section>

      <aside className="projects-aside">
        <div className="eyebrow">{t("projects.status")}</div>
        <h2 className="font-editorial aside-title">
          {t("projects.statusTitle")}
        </h2>
        <div className="workspace-facts">
          <WorkspaceFact
            label={t("projects.active")}
            value={loading ? "..." : String(activeProjects.length)}
          />
          <WorkspaceFact label={t("projects.storage")} value="PostgreSQL" />
          <WorkspaceFact
            label={t("projects.session")}
            value={t("projects.anonymous")}
          />
        </div>

        <div className="deleted-projects">
          <div className="section-heading">
            <h3>{t("projects.recentlyDeleted")}</h3>
            <span>{deletedProjects.length}</span>
          </div>
          {deletedProjects.length > 0 ? (
            deletedProjects.map((project) => (
              <div className="deleted-project-row" key={project.id}>
                <div>
                  <b>{project.name}</b>
                  <span>{formatRelativeTime(project.updatedAt, locale)}</span>
                </div>
                <Button
                  aria-label={t("projects.restore", { name: project.name })}
                  disabled={pendingProjectId === project.id}
                  onClick={() => void mutateProject(project, "restore")}
                  size="icon-sm"
                  variant="ghost"
                >
                  {pendingProjectId === project.id ? (
                    <LoaderCircle className="project-state-spinner" />
                  ) : (
                    <RotateCcw />
                  )}
                </Button>
              </div>
            ))
          ) : (
            <p className="deleted-projects-empty">
              {t("projects.noRecoverable")}
            </p>
          )}
        </div>
      </aside>

      <Dialog
        open={projectToDelete !== null}
        onOpenChange={(open) => {
          if (!open && pendingProjectId === null) {
            setProjectToDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("projects.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {projectToDelete
                ? t("projects.deleteDescription", {
                    name: projectToDelete.name,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={pendingProjectId !== null} variant="outline">
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button
              disabled={!projectToDelete || pendingProjectId !== null}
              onClick={() =>
                projectToDelete
                  ? void mutateProject(projectToDelete, "delete")
                  : undefined
              }
              variant="destructive"
            >
              {pendingProjectId ? (
                <LoaderCircle className="project-state-spinner" />
              ) : (
                <Trash2 data-icon="inline-start" />
              )}
              {t("projects.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ProjectRow({
  index,
  onDelete,
  project,
}: {
  index: number;
  onDelete: () => void;
  project: ProjectSummary;
}) {
  const { locale, t } = useUiI18n();
  const thumbClass = ["finance", "notes", "store"][index % 3];

  return (
    <div className="project-row">
      <Link
        aria-label={`打开 ${project.name}`}
        className="project-row-link"
        href={`/p/${project.id}`}
      >
        <span className={`project-thumb ${thumbClass}`} />
        <span className="project-name">
          <b>{project.name}</b>
          <span>
            Revision {project.revision} ·{" "}
            {formatProjectStatus(project.status, t)}
          </span>
        </span>
        <span className="storage-badge">
          {formatStorageKind(project.storageKind, t)}
        </span>
        <span className="project-meta">
          {formatRelativeTime(project.updatedAt, locale)}
        </span>
        <ArrowUpRight className="project-arrow" />
      </Link>
      <Button
        aria-label={`删除 ${project.name}`}
        className="project-delete-button"
        onClick={onDelete}
        size="icon-sm"
        variant="ghost"
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function WorkspaceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="workspace-fact">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function readApiMessage(
  body: unknown,
  locale: "zh" | "en",
  fallbackKey:
    | "projects.loadFailed"
    | "projects.operationFailed"
    | "projects.restoreFailed",
): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "code" in body.error &&
    typeof body.error.code === "string"
  ) {
    return getLocalizedErrorMessage(body.error.code, locale);
  }

  if (fallbackKey === "projects.loadFailed") {
    return locale === "zh"
      ? "项目列表加载失败。"
      : "Project list failed to load.";
  }
  if (fallbackKey === "projects.restoreFailed") {
    return locale === "zh" ? "恢复项目失败。" : "Project restore failed.";
  }
  return locale === "zh" ? "项目操作失败。" : "Project operation failed.";
}

function formatStorageKind(
  storageKind: ProjectSummary["storageKind"],
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  return storageKind === "database"
    ? t("projects.database")
    : t("projects.browserGit");
}

function formatProjectStatus(
  status: ProjectSummary["status"],
  t: (key: string, values?: Record<string, string | number>) => string,
) {
  const labels: Record<ProjectSummary["status"], string> = {
    creating: t("projects.statusCreating"),
    ready: t("projects.statusReady"),
    unavailable: t("projects.statusUnavailable"),
    error: t("projects.statusError"),
  };

  return labels[status] ?? t("projects.statusError");
}

function formatRelativeTime(value: string, locale: "zh" | "en"): string {
  const timestamp = new Date(value).getTime();
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1000),
  );

  if (elapsedSeconds < 60) {
    return locale === "zh" ? "刚刚" : "Just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return locale === "zh"
      ? `${elapsedMinutes} 分钟前`
      : `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return locale === "zh" ? `${elapsedHours} 小时前` : `${elapsedHours}h ago`;
  }

  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
