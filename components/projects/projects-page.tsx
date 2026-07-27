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
    message?: string;
  };
};

async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch("/api/projects?includeDeleted=true", {
    cache: "no-store",
  });
  const body = (await response.json()) as
    ProjectListResponse | ApiErrorResponse;

  if (!response.ok || !("projects" in body)) {
    throw new Error(readApiMessage(body, "项目列表加载失败。"));
  }

  return body.projects;
}

export function ProjectsPage() {
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
      setProjects(await fetchProjects());
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "项目列表加载失败。",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    // 首屏 effect 只等待外部请求结果，不在 effect 主体同步切换 state，
    // 这样 React 不会为了 loading 状态再触发一轮级联渲染。
    void fetchProjects()
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
              : "项目列表加载失败。",
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
  }, []);

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
      const response = await fetch(`/api/projects/${project.id}/${action}`, {
        method: "POST",
      });
      const body = (await response.json()) as ApiErrorResponse;

      if (!response.ok) {
        throw new Error(
          readApiMessage(
            body,
            action === "delete" ? "删除项目失败。" : "恢复项目失败。",
          ),
        );
      }

      setProjectToDelete(null);
      await loadProjects();
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "项目操作失败。",
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
            <div className="eyebrow">Your workspace</div>
            <h1 className="font-editorial projects-title">
              Make something
              <br />
              worth keeping.
            </h1>
            <p className="projects-lede">
              从一个想法开始，WebPilot
              会修改代码、运行项目、验证交互，并留下每一次变化的证据。
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/new">
              <Plus data-icon="inline-start" />
              New project
            </Link>
          </Button>
        </div>

        <div className="start-composer panel">
          <textarea
            aria-label="描述你想构建的项目"
            className="composer-input"
            defaultValue="Describe what you want to build…"
          />
          <div className="composer-actions">
            <div className="composer-left">
              <Button disabled size="sm" variant="outline">
                <Plus data-icon="inline-start" />
                Image
              </Button>
              <Button disabled size="sm" variant="outline">
                React + TypeScript
              </Button>
            </div>
            <Button asChild className="app-button-accent" size="sm">
              <Link href="/new">
                Start building
                <Send data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        </div>

        <div className="section-heading">
          <h2>Recent projects</h2>
          <span>
            {activeProjects.length}{" "}
            {activeProjects.length === 1 ? "project" : "projects"}
          </span>
        </div>

        {error ? (
          <div className="project-state project-state-error" role="alert">
            <AlertCircle />
            <div>
              <b>Workspace unavailable</b>
              <span>{error}</span>
            </div>
            <Button
              onClick={() => void loadProjects()}
              size="sm"
              variant="outline"
            >
              <RotateCcw data-icon="inline-start" />
              Retry
            </Button>
          </div>
        ) : null}

        {loading ? (
          <div className="project-state" aria-live="polite">
            <LoaderCircle className="project-state-spinner" />
            <div>
              <b>Loading workspace</b>
              <span>正在恢复当前匿名会话中的项目。</span>
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
            <h3 className="font-editorial">A clean workspace.</h3>
            <p>创建第一个数据库项目，代码会在刷新后继续保留。</p>
            <Button asChild size="sm">
              <Link href="/new">
                <Plus data-icon="inline-start" />
                Create project
              </Link>
            </Button>
          </div>
        )}
      </section>

      <aside className="projects-aside">
        <div className="eyebrow">Workspace status</div>
        <h2 className="font-editorial aside-title">Stored with context</h2>
        <div className="workspace-facts">
          <WorkspaceFact
            label="Active projects"
            value={loading ? "..." : String(activeProjects.length)}
          />
          <WorkspaceFact label="Storage" value="PostgreSQL" />
          <WorkspaceFact label="Session" value="Anonymous" />
        </div>

        <div className="deleted-projects">
          <div className="section-heading">
            <h3>Recently deleted</h3>
            <span>{deletedProjects.length}</span>
          </div>
          {deletedProjects.length > 0 ? (
            deletedProjects.map((project) => (
              <div className="deleted-project-row" key={project.id}>
                <div>
                  <b>{project.name}</b>
                  <span>{formatRelativeTime(project.updatedAt)}</span>
                </div>
                <Button
                  aria-label={`恢复 ${project.name}`}
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
            <p className="deleted-projects-empty">没有可恢复的项目。</p>
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
            <DialogTitle>删除项目？</DialogTitle>
            <DialogDescription>
              {projectToDelete?.name} 将从项目列表移除，但仍可从右侧恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button disabled={pendingProjectId !== null} variant="outline">
                Cancel
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
              Delete
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
            Revision {project.revision} · {formatProjectStatus(project.status)}
          </span>
        </span>
        <span className="storage-badge">
          {formatStorageKind(project.storageKind)}
        </span>
        <span className="project-meta">
          {formatRelativeTime(project.updatedAt)}
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

function readApiMessage(body: unknown, fallback: string): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }

  return fallback;
}

function formatStorageKind(storageKind: ProjectSummary["storageKind"]) {
  return storageKind === "database" ? "Database" : "Browser Git";
}

function formatProjectStatus(status: ProjectSummary["status"]) {
  const labels: Record<ProjectSummary["status"], string> = {
    creating: "Creating",
    ready: "Ready",
    error: "Needs attention",
  };

  return labels[status];
}

function formatRelativeTime(value: string): string {
  const timestamp = new Date(value).getTime();
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1000),
  );

  if (elapsedSeconds < 60) {
    return "Just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}
