"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  Send,
  Smartphone,
} from "lucide-react";

import { PreviewSite } from "@/components/demo/preview-site";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { BrowserGitProjectRepository } from "@/domains/project/browser-git-repository";
import { buildProjectTemplate } from "@/domains/project/template";
import type {
  ProjectDescription,
  ProjectFileSnapshot,
} from "@/domains/project/types";
import { webContainerRuntimeManager } from "@/infrastructure/webcontainer/runtime-manager";

export function PublishPage({
  adminMode,
  project,
}: {
  adminMode: boolean;
  project: ProjectDescription;
}) {
  const [buildState, setBuildState] = useState<BuildState>({
    phase: "idle",
    message: "尚未构建",
    detail: "",
  });
  const [dirtyPaths] = useState<string[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }

    const stored = window.sessionStorage.getItem(
      `webpilot:dirty-drafts:${project.id}`,
    );
    return stored ? parseDirtyPaths(stored) : [];
  });
  const [repositoryFiles, setRepositoryFiles] = useState<ProjectFileSnapshot[]>(
    [],
  );
  const [repositoryRevision, setRepositoryRevision] = useState(
    project.revision,
  );
  const [adminToken, setAdminToken] = useState("");
  const [publishTitle, setPublishTitle] = useState(project.name);
  const [publishDescription, setPublishDescription] = useState("");
  const [publishSlug, setPublishSlug] = useState(
    toSlug(project.name) || "webpilot-project",
  );
  const [publishCoverUrl, setPublishCoverUrl] = useState("");
  const [publishSortOrder, setPublishSortOrder] = useState("0");
  const [publishState, setPublishState] = useState<PublishState>({
    phase: "idle",
    message: "等待管理员发布",
    detail: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function loadRepositorySnapshot() {
      try {
        const snapshot =
          project.storageKind === "browser_git"
            ? await loadBrowserGitSnapshot(project)
            : await loadDatabaseSnapshot(project.id);

        if (!cancelled) {
          setRepositoryFiles(snapshot.files);
          setRepositoryRevision(snapshot.revision);
          setBuildState((current) =>
            current.phase === "idle"
              ? {
                  ...current,
                  detail: `${snapshot.files.length} 个文件 · revision ${snapshot.revision}`,
                }
              : current,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setBuildState({
            phase: "failed",
            message: "无法读取当前 Repository",
            detail:
              error instanceof Error ? error.message : "请返回工作台重试。",
          });
        }
      }
    }

    void loadRepositorySnapshot();
    return () => {
      cancelled = true;
    };
  }, [project]);

  const canBuild = useMemo(
    () =>
      buildState.phase !== "building" &&
      dirtyPaths.length === 0 &&
      repositoryFiles.length > 0,
    [buildState.phase, dirtyPaths.length, repositoryFiles.length],
  );
  const canPublish = useMemo(
    () =>
      adminMode &&
      adminToken.trim().length > 0 &&
      buildState.phase === "success" &&
      publishTitle.trim().length > 0 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publishSlug.trim()) &&
      publishSlug.trim().length <= 160 &&
      Number.isInteger(Number(publishSortOrder)),
    [
      adminMode,
      adminToken,
      buildState.phase,
      publishTitle,
      publishSlug,
      publishSortOrder,
    ],
  );

  async function handleBuildAndDownload() {
    if (dirtyPaths.length > 0) {
      setBuildState({
        phase: "blocked",
        message: "存在未保存草稿",
        detail: dirtyPaths.join("、"),
      });
      return;
    }

    if (repositoryFiles.length === 0) {
      setBuildState({
        phase: "blocked",
        message: "当前项目没有可构建文件",
        detail: "请先在工作台创建并保存代码。",
      });
      return;
    }

    setBuildState({
      phase: "building",
      message: "正在准备 production build",
      detail: "仅在你点击此按钮后启动 WebContainer。",
    });

    try {
      const result = await webContainerRuntimeManager.buildProduction(
        buildProjectTemplate(
          repositoryFiles.map((file) => ({
            path: file.path,
            content: file.content,
          })),
        ),
        project.id,
        repositoryRevision,
        `showcase:${project.id}:${repositoryRevision}`,
      );
      const archive = new Blob([toArrayBuffer(result.archive)], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(archive);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${toSafeFileName(project.name)}-showcase.zip`;
      anchor.click();
      URL.revokeObjectURL(url);

      setBuildState({
        phase: "success",
        message: "ZIP 已生成",
        detail: `${result.manifest.files.length} 个文件 · ${formatBytes(
          result.manifest.totalBytes,
        )} · ${result.buildDurationMs}ms`,
        result,
      });
    } catch (error) {
      setBuildState({
        phase: "failed",
        message: "生产构建失败",
        detail:
          error instanceof Error ? error.message : "请查看运行日志后重试。",
      });
    }
  }

  async function handlePublish() {
    if (!buildState.result || !canPublish) {
      setPublishState({
        phase: "blocked",
        message: "暂时不能发布",
        detail: "请先完成 production build，并确认管理员设置有效。",
      });
      return;
    }

    setPublishState({
      phase: "publishing",
      message: "正在发布 Showcase",
      detail: "正在上传不可变 artifact 并写入发布元数据。",
    });

    try {
      const response = await fetch("/api/showcase/admin/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-showcase-admin-token": adminToken.trim(),
        },
        body: JSON.stringify({
          projectId: project.id,
          title: publishTitle.trim(),
          slug: publishSlug.trim(),
          description: publishDescription.trim() || null,
          coverUrl: publishCoverUrl.trim() || null,
          sortOrder: Number(publishSortOrder),
          sourceRevision: repositoryRevision,
          manifest: buildState.result.manifest,
          files: buildState.result.files.map((file) => ({
            path: file.path,
            hash: file.hash,
            contentBase64: toBase64(file.content),
          })),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        case?: { slug: string };
        error?: { message?: string };
      };

      if (!response.ok || !body.case) {
        throw new Error(body.error?.message ?? "Showcase 发布失败。");
      }

      setPublishState({
        phase: "success",
        message: "Showcase 已发布",
        detail: `公开地址：/showcase/${body.case.slug}`,
      });
    } catch (error) {
      setPublishState({
        phase: "failed",
        message: "Showcase 发布失败",
        detail:
          error instanceof Error ? error.message : "请检查管理 token 后重试。",
      });
    }
  }

  return (
    <div className="publish-page page-in">
      <section className="publish-preview">
        <div className="publish-preview-head">
          <b>Publish preview</b>
          <ToggleGroup
            aria-label="预览设备"
            className="device-switch"
            defaultValue="desktop"
            type="single"
          >
            <ToggleGroupItem aria-label="桌面预览" value="desktop">
              <span className="desktop-device-icon" />
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="移动端预览" value="mobile">
              <Smartphone />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="publish-canvas">
          <PreviewSite />
        </div>
        <div className="build-status">
          <BuildStep label="Production build" state={buildState.phase} />
          <BuildStep
            label={
              buildState.result
                ? `${buildState.result.manifest.files.length} assets collected`
                : "Assets collected"
            }
            state={buildState.result ? "success" : "idle"}
          />
          <BuildStep
            label={
              buildState.result
                ? `${formatBytes(buildState.result.manifest.totalBytes)} ZIP`
                : "ZIP export"
            }
            state={buildState.result ? "success" : "idle"}
          />
        </div>
      </section>

      <section className="publish-settings">
        <div className="eyebrow">Showcase / Publish</div>
        <h1 className="font-editorial publish-title">
          Ready for
          <br />
          the outside world.
        </h1>
        <p>
          发布的是经过生产构建的静态产物，不会在服务端执行项目源码。发布后可以随时撤销或更新。
        </p>

        <div className="publish-form-grid">
          <div className="wide">
            <label className="field-label" htmlFor="publish-title">
              Title
            </label>
            <input
              className="field"
              id="publish-title"
              onChange={(event) => setPublishTitle(event.target.value)}
              value={publishTitle}
            />
          </div>
          <div className="wide">
            <label className="field-label" htmlFor="publish-description">
              Description
            </label>
            <textarea
              className="field"
              id="publish-description"
              onChange={(event) => setPublishDescription(event.target.value)}
              value={publishDescription}
            />
          </div>
          <div className="wide">
            <label className="field-label" htmlFor="public-url">
              Public URL
            </label>
            <div className="slug-field">
              <span className="slug-prefix">webpilot.studio/showcase/</span>
              <input
                className="field"
                id="public-url"
                onChange={(event) => setPublishSlug(event.target.value)}
                value={publishSlug}
              />
            </div>
          </div>
          <div className="wide">
            <span className="field-label">Cover</span>
            <div className="cover-picker">
              <div className="cover-thumb" />
              <div className="cover-copy">
                <b>Current preview capture</b>
                <span>
                  1440 × 900 · Captured after the latest successful browser run.
                </span>
              </div>
            </div>
            {adminMode ? (
              <input
                aria-label="Showcase cover URL"
                className="field cover-url-field"
                onChange={(event) => setPublishCoverUrl(event.target.value)}
                placeholder="可选：公开封面图片 URL"
                type="url"
                value={publishCoverUrl}
              />
            ) : null}
          </div>
          {adminMode ? (
            <>
              <div>
                <label className="field-label" htmlFor="publish-sort-order">
                  Sort order
                </label>
                <input
                  className="field"
                  id="publish-sort-order"
                  inputMode="numeric"
                  onChange={(event) => setPublishSortOrder(event.target.value)}
                  type="number"
                  value={publishSortOrder}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="showcase-admin-token">
                  Admin token
                </label>
                <input
                  className="field"
                  id="showcase-admin-token"
                  onChange={(event) => setAdminToken(event.target.value)}
                  placeholder="仅本次请求使用"
                  type="password"
                  value={adminToken}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="publish-checks">
          <CheckRow
            label="Repository snapshot"
            value={
              repositoryFiles.length > 0 ? `r${repositoryRevision}` : "Loading"
            }
          />
          <CheckRow
            label="Unsaved Monaco drafts"
            value={
              dirtyPaths.length === 0 ? "0" : `${dirtyPaths.length} blocked`
            }
          />
          <CheckRow label="Build status" value={buildState.message} />
          <CheckRow
            label="Entry file"
            value={buildState.result ? "index.html" : "Pending"}
          />
        </div>
        <div className="publish-build-feedback" role="status">
          <b>{buildState.message}</b>
          <span>{buildState.detail}</span>
        </div>
        <div className="publish-actions">
          <span>
            {buildState.result
              ? "ZIP ready to review"
              : "Explicit build required"}
          </span>
          <Button
            className="app-button-accent"
            disabled={!canBuild}
            onClick={handleBuildAndDownload}
            size="sm"
          >
            {buildState.phase === "building" ? (
              <LoaderCircle className="animate-spin" data-icon="inline-start" />
            ) : buildState.result ? (
              <Download data-icon="inline-start" />
            ) : (
              <ExternalLink data-icon="inline-start" />
            )}
            {buildState.phase === "building"
              ? "Building..."
              : buildState.result
                ? "Build again"
                : "Build & download ZIP"}
          </Button>
        </div>
        {adminMode ? (
          <div className="showcase-admin-panel">
            <div className="showcase-admin-panel-head">
              <span>
                <LockKeyhole aria-hidden="true" />
                Showcase admin mode
              </span>
              <small>普通匿名访问不会显示此区域</small>
            </div>
            <p>
              发布会复用当前已完成的 production
              artifact，不会重新安装依赖或执行第二次构建。
            </p>
            <Button
              className="app-button-accent"
              disabled={!canPublish}
              onClick={() => void handlePublish()}
              size="sm"
            >
              {publishState.phase === "publishing" ? (
                <LoaderCircle
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : publishState.phase === "success" ? (
                <Check data-icon="inline-start" />
              ) : (
                <Send data-icon="inline-start" />
              )}
              {publishState.phase === "publishing"
                ? "Publishing..."
                : publishState.phase === "success"
                  ? "Published"
                  : "Publish Showcase"}
            </Button>
            <div className="publish-build-feedback" role="status">
              <b>{publishState.message}</b>
              <span>{publishState.detail}</span>
            </div>
          </div>
        ) : null}
        <Link className="back-to-workbench" href={`/p/${project.id}`}>
          返回 Agent 工作台
        </Link>
      </section>
    </div>
  );
}

function BuildStep({
  label,
  state,
}: {
  label: string;
  state: BuildState["phase"] | "idle";
}) {
  return (
    <div className={`build-step is-${state}`}>
      <span className="build-check" aria-hidden="true">
        {state === "building" ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <Check />
        )}
      </span>
      <span>{label}</span>
    </div>
  );
}

type BuildState = {
  phase: "idle" | "building" | "success" | "failed" | "blocked";
  message: string;
  detail: string;
  result?: Awaited<
    ReturnType<typeof webContainerRuntimeManager.buildProduction>
  >;
};

async function loadDatabaseSnapshot(projectId: string) {
  const response = await fetch(`/api/projects/${projectId}/files`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    files?: ProjectFileSnapshot[];
    error?: { message?: string };
  };

  if (!response.ok || !body.files) {
    throw new Error(body.error?.message ?? "数据库 Repository 读取失败。");
  }

  return {
    files: body.files,
    revision: await loadProjectRevision(projectId),
  };
}

async function loadBrowserGitSnapshot(project: ProjectDescription) {
  const repository = new BrowserGitProjectRepository(project);
  await repository.initialize();
  const [files, description] = await Promise.all([
    repository.listFiles(),
    repository.describe(),
  ]);
  return { files, revision: description.revision };
}

async function loadProjectRevision(projectId: string): Promise<number> {
  const response = await fetch(`/api/projects/${projectId}`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    project?: ProjectDescription;
    error?: { message?: string };
  };

  if (!response.ok || !body.project) {
    throw new Error(body.error?.message ?? "项目 revision 读取失败。");
  }

  return body.project.revision;
}

function parseDirtyPaths(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function toSafeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "webpilot-project"
  );
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < value.length; index += chunkSize) {
    binary += String.fromCharCode(...value.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

type PublishState = {
  phase: "idle" | "publishing" | "success" | "failed" | "blocked";
  message: string;
  detail: string;
};

function CheckRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="check-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
