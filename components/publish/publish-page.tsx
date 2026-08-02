"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
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
import { useUiI18n } from "@/infrastructure/i18n/ui";
import {
  type WebContainerRuntimeAsset,
  webContainerRuntimeManager,
} from "@/infrastructure/webcontainer/runtime-manager";

export function PublishPage({
  adminMode,
  project,
}: {
  adminMode: boolean;
  project: ProjectDescription;
}) {
  const { t } = useUiI18n();
  const [buildState, setBuildState] = useState<BuildState>({
    phase: "idle",
    message: t("publish.notBuilt"),
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
  const [runtimeAssets, setRuntimeAssets] = useState<
    WebContainerRuntimeAsset[]
  >([]);
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null);
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
  const [publishCaseId, setPublishCaseId] = useState<string | null>(null);
  const [adminCandidates, setAdminCandidates] = useState<ShowcaseAdminCase[]>(
    [],
  );
  const [candidateState, setCandidateState] = useState<CandidateState>({
    phase: "idle",
    message: t("publish.candidatesNotLoaded"),
    detail: "",
  });
  const [publishState, setPublishState] = useState<PublishState>({
    phase: "idle",
    message: t("publish.waitingForAdmin"),
    detail: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function loadRepositorySnapshot() {
      try {
        const snapshot =
          project.storageKind === "browser_git"
            ? await loadBrowserGitSnapshot(project)
            : await loadDatabaseSnapshot(project.id, t);

        if (!cancelled) {
          setRepositoryFiles(snapshot.files);
          setRepositoryRevision(snapshot.revision);
          setBuildState((current) =>
            current.phase === "idle"
              ? {
                  ...current,
                  detail: t("publish.repositorySnapshotDetail", {
                    count: snapshot.files.length,
                    revision: snapshot.revision,
                  }),
                }
              : current,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setBuildState({
            phase: "failed",
            message: t("publish.repositoryReadFailed"),
            detail:
              error instanceof Error
                ? error.message
                : t("publish.returnToWorkbenchRetry"),
          });
        }
      }
    }

    void loadRepositorySnapshot();
    return () => {
      cancelled = true;
    };
  }, [project, t]);

  useEffect(() => {
    let cancelled = false;

    async function loadRuntimeAssets() {
      try {
        const response = await fetch(`/api/projects/${project.id}/assets`, {
          cache: "no-store",
        });
        const body = (await response.json().catch(() => ({}))) as {
          assets?: Array<WebContainerRuntimeAsset & { downloadUrl?: string }>;
          error?: { message?: string };
        };

        if (!response.ok || !body.assets) {
          throw new Error(body.error?.message ?? t("publish.assetLoadFailed"));
        }

        if (!cancelled) {
          setRuntimeAssets(
            body.assets.filter(
              (
                asset,
              ): asset is WebContainerRuntimeAsset & {
                downloadUrl: string;
              } => typeof asset.downloadUrl === "string",
            ),
          );
          setAssetLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeAssets([]);
          setAssetLoadError(
            error instanceof Error
              ? error.message
              : t("publish.assetLoadFailed"),
          );
        }
      }
    }

    void loadRuntimeAssets();
    return () => {
      cancelled = true;
    };
  }, [project.id, t]);

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
        message: t("publish.unsavedDraftsBlocked"),
        detail: dirtyPaths.join("、"),
      });
      return;
    }

    if (repositoryFiles.length === 0) {
      setBuildState({
        phase: "blocked",
        message: t("publish.noBuildFiles"),
        detail: t("publish.createAndSaveCode"),
      });
      return;
    }

    setBuildState({
      phase: "building",
      message: t("publish.preparingBuild"),
      detail: t("publish.buildOnlyAfterClick"),
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
        runtimeAssets,
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
        message: t("publish.zipGenerated"),
        detail: t("publish.buildResultDetail", {
          count: result.manifest.files.length,
          size: formatBytes(result.manifest.totalBytes),
          duration: result.buildDurationMs,
        }),
        result,
      });
    } catch (error) {
      setBuildState({
        phase: "failed",
        message: t("publish.productionBuildFailed"),
        detail:
          error instanceof Error ? error.message : t("publish.checkLogsRetry"),
      });
    }
  }

  async function handlePublish() {
    if (!buildState.result || !canPublish) {
      setPublishState({
        phase: "blocked",
        message: t("publish.cannotPublish"),
        detail: t("publish.completeBuildAndCheckAdmin"),
      });
      return;
    }

    setPublishState({
      phase: "publishing",
      message: t("publish.publishing"),
      detail: t("publish.uploadingArtifact"),
    });

    try {
      const response = await fetch("/api/showcase/admin/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-showcase-admin-token": adminToken.trim(),
        },
        body: JSON.stringify({
          caseId: publishCaseId ?? undefined,
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
        case?: { id: string; projectId: string | null; slug: string };
        error?: { message?: string };
      };

      if (!response.ok || !body.case) {
        throw new Error(body.error?.message ?? t("publish.publishFailed"));
      }

      setPublishState({
        phase: "success",
        message: t("publish.published"),
        detail: t("publish.publicAddress", { slug: body.case.slug }),
      });
      setPublishCaseId(body.case.id);
      setCandidateState((current) => ({
        ...current,
        message: t("publish.candidatesUpdated"),
      }));
    } catch (error) {
      setPublishState({
        phase: "failed",
        message: t("publish.publishFailed"),
        detail:
          error instanceof Error
            ? error.message
            : t("publish.checkAdminTokenRetry"),
      });
    }
  }

  async function handleLoadCandidates() {
    const token = adminToken.trim();
    if (!adminMode || !token) {
      setCandidateState({
        phase: "blocked",
        message: t("publish.adminTokenRequired"),
        detail: t("publish.candidatesAnonymousBlocked"),
      });
      return;
    }

    setCandidateState({
      phase: "loading",
      message: t("publish.loadingCandidates"),
      detail: t("publish.metadataOnly"),
    });

    try {
      const response = await fetch("/api/showcase/admin/candidates", {
        headers: {
          "x-showcase-admin-token": token,
        },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as {
        cases?: ShowcaseAdminCase[];
        error?: { message?: string };
      };

      if (!response.ok || !body.cases) {
        throw new Error(
          body.error?.message ?? t("publish.candidatesLoadFailed"),
        );
      }

      setAdminCandidates(body.cases);
      const currentCase = body.cases.find(
        (item) => item.projectId === project.id,
      );

      if (currentCase) {
        setPublishCaseId(currentCase.id);
        setPublishTitle(currentCase.title);
        setPublishSlug(currentCase.slug);
        setPublishDescription(currentCase.description ?? "");
        setPublishCoverUrl(currentCase.coverUrl ?? "");
        setPublishSortOrder(String(currentCase.sortOrder));
      } else {
        setPublishCaseId(null);
      }

      setCandidateState({
        phase: "success",
        message: currentCase
          ? t("publish.currentCaseFound")
          : t("publish.candidatesLoaded"),
        detail: t("publish.casesManageable", { count: body.cases.length }),
      });
    } catch (error) {
      setCandidateState({
        phase: "failed",
        message: t("publish.candidatesLoadFailed"),
        detail:
          error instanceof Error
            ? error.message
            : t("publish.checkAdminTokenRetry"),
      });
    }
  }

  async function handleRevoke() {
    if (!publishCaseId || !adminToken.trim()) {
      setCandidateState({
        phase: "blocked",
        message: t("publish.cannotRevoke"),
        detail: t("publish.loadCurrentCaseFirst"),
      });
      return;
    }

    setCandidateState({
      phase: "loading",
      message: t("publish.revoking"),
      detail: t("publish.revokeEffect"),
    });

    try {
      const response = await fetch(
        `/api/showcase/admin/${publishCaseId}/revoke`,
        {
          method: "POST",
          headers: {
            "x-showcase-admin-token": adminToken.trim(),
          },
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(body.error?.message ?? t("publish.revokeFailed"));
      }

      setAdminCandidates((current) =>
        current.map((item) =>
          item.id === publishCaseId
            ? { ...item, status: "revoked", artifact: null }
            : item,
        ),
      );
      setCandidateState({
        phase: "success",
        message: t("publish.revoked"),
        detail: t("publish.republishCreatesArtifact"),
      });
    } catch (error) {
      setCandidateState({
        phase: "failed",
        message: t("publish.revokeFailed"),
        detail:
          error instanceof Error
            ? error.message
            : t("publish.checkAdminTokenRetry"),
      });
    }
  }

  return (
    <div className="publish-page page-in">
      <section className="publish-preview">
        <div className="publish-preview-head">
          <b>{t("publish.preview")}</b>
          <ToggleGroup
            aria-label={t("publish.previewDevice")}
            className="device-switch"
            defaultValue="desktop"
            type="single"
          >
            <ToggleGroupItem
              aria-label={t("publish.desktopPreview")}
              value="desktop"
            >
              <span className="desktop-device-icon" />
            </ToggleGroupItem>
            <ToggleGroupItem
              aria-label={t("publish.mobilePreview")}
              value="mobile"
            >
              <Smartphone />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="publish-canvas">
          <PreviewSite />
        </div>
        <div className="build-status">
          <BuildStep
            label={t("publish.productionBuild")}
            state={buildState.phase}
          />
          <BuildStep
            label={
              buildState.result
                ? t("publish.assetsCollectedCount", {
                    count: buildState.result.manifest.files.length,
                  })
                : t("publish.assetsCollected")
            }
            state={buildState.result ? "success" : "idle"}
          />
          <BuildStep
            label={
              buildState.result
                ? t("publish.zipSize", {
                    size: formatBytes(buildState.result.manifest.totalBytes),
                  })
                : t("publish.zipExport")
            }
            state={buildState.result ? "success" : "idle"}
          />
        </div>
      </section>

      <section className="publish-settings">
        <div className="eyebrow">{t("publish.eyebrow")}</div>
        <h1 className="font-editorial publish-title">
          {t("publish.title").split("\n")[0]}
          <br />
          {t("publish.title").split("\n")[1]}
        </h1>
        <p>{t("publish.description")}</p>

        <div className="publish-form-grid">
          <div className="wide">
            <label className="field-label" htmlFor="publish-title">
              {t("publish.titleLabel")}
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
              {t("publish.descriptionLabel")}
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
              {t("publish.publicUrl")}
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
            <span className="field-label">{t("publish.cover")}</span>
            <div className="cover-picker">
              <div className="cover-thumb" />
              <div className="cover-copy">
                <b>{t("publish.coverCapture")}</b>
                <span>{t("publish.coverCaptureDetail")}</span>
              </div>
            </div>
            {adminMode ? (
              <input
                aria-label={t("publish.coverUrl")}
                className="field cover-url-field"
                onChange={(event) => setPublishCoverUrl(event.target.value)}
                placeholder={t("publish.coverUrlPlaceholder")}
                type="url"
                value={publishCoverUrl}
              />
            ) : null}
          </div>
          {adminMode ? (
            <>
              <div>
                <label className="field-label" htmlFor="publish-sort-order">
                  {t("publish.sortOrder")}
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
                  {t("publish.adminToken")}
                </label>
                <div className="admin-token-row">
                  <input
                    className="field"
                    id="showcase-admin-token"
                    onChange={(event) => setAdminToken(event.target.value)}
                    placeholder={t("publish.adminTokenPlaceholder")}
                    type="password"
                    value={adminToken}
                  />
                  <Button
                    aria-label={t("publish.loadCandidates")}
                    className="app-button-quiet"
                    disabled={
                      candidateState.phase === "loading" ||
                      adminToken.trim().length === 0
                    }
                    onClick={() => void handleLoadCandidates()}
                    size="icon"
                    title={t("publish.loadCandidates")}
                  >
                    {candidateState.phase === "loading" ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="publish-checks">
          <CheckRow
            label={t("publish.repositorySnapshot")}
            value={
              repositoryFiles.length > 0
                ? `r${repositoryRevision}`
                : t("publish.loading")
            }
          />
          <CheckRow
            label={t("publish.unsavedDrafts")}
            value={
              dirtyPaths.length === 0
                ? "0"
                : t("publish.blockedDrafts", { count: dirtyPaths.length })
            }
          />
          <CheckRow
            label={t("publish.buildStatus")}
            value={buildState.message}
          />
          <CheckRow
            label={t("publish.entryFile")}
            value={buildState.result ? "index.html" : t("publish.pending")}
          />
        </div>
        <div className="publish-build-feedback" role="status">
          <b>{buildState.message}</b>
          <span>{buildState.detail}</span>
        </div>
        {assetLoadError ? (
          <div className="publish-build-feedback" role="alert">
            <b>{t("publish.assetLoadFailed")}</b>
            <span>{assetLoadError}</span>
          </div>
        ) : null}
        <div className="publish-actions">
          <span>
            {buildState.result
              ? t("publish.zipReady")
              : t("publish.explicitBuild")}
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
              ? t("publish.building")
              : buildState.result
                ? t("publish.buildAgain")
                : t("publish.buildDownload")}
          </Button>
        </div>
        {adminMode ? (
          <div className="showcase-admin-panel">
            <div className="showcase-admin-panel-head">
              <span>
                <LockKeyhole aria-hidden="true" />
                {t("publish.adminMode")}
              </span>
              <small>{t("publish.adminHint")}</small>
            </div>
            <p>{t("publish.adminDescription")}</p>
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
                ? t("publish.publishing")
                : publishState.phase === "success"
                  ? t("publish.published")
                  : t("publish.publish")}
            </Button>
            <div className="publish-build-feedback" role="status">
              <b>{publishState.message}</b>
              <span>{publishState.detail}</span>
            </div>
            <div className="publish-build-feedback" role="status">
              <b>{candidateState.message}</b>
              <span>{candidateState.detail}</span>
            </div>
            {adminCandidates.length > 0 ? (
              <div className="showcase-candidate-list">
                <div className="showcase-candidate-list-head">
                  <span>{t("publish.candidateCases")}</span>
                  <small>
                    {t("publish.total", { count: adminCandidates.length })}
                  </small>
                </div>
                {adminCandidates.map((item) => (
                  <button
                    className={`showcase-candidate ${
                      item.id === publishCaseId ? "is-selected" : ""
                    }`}
                    disabled={item.projectId !== project.id}
                    key={item.id}
                    onClick={() => {
                      if (item.projectId !== project.id) {
                        return;
                      }
                      setPublishCaseId(item.id);
                      setPublishTitle(item.title);
                      setPublishSlug(item.slug);
                      setPublishDescription(item.description ?? "");
                      setPublishCoverUrl(item.coverUrl ?? "");
                      setPublishSortOrder(String(item.sortOrder));
                    }}
                    type="button"
                  >
                    <span>
                      <b>{item.title}</b>
                      <small>
                        {item.status} · {item.slug}
                      </small>
                    </span>
                    <span className="showcase-candidate-revision">
                      {item.artifact
                        ? `r${item.artifact.sourceRevision}`
                        : t("publish.noArtifact")}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {publishCaseId ? (
              <Button
                className="app-button-danger"
                disabled={
                  candidateState.phase === "loading" ||
                  publishState.phase === "publishing"
                }
                onClick={() => void handleRevoke()}
                size="sm"
                variant="outline"
              >
                <Ban data-icon="inline-start" />
                {t("publish.revoke")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Link className="back-to-workbench" href={`/p/${project.id}`}>
          {t("publish.backToWorkbench")}
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

async function loadDatabaseSnapshot(
  projectId: string,
  translate: (key: string) => string,
) {
  const response = await fetch(`/api/projects/${projectId}/files`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    files?: ProjectFileSnapshot[];
    error?: { message?: string };
  };

  if (!response.ok || !body.files) {
    throw new Error(
      body.error?.message ?? translate("publish.databaseRepositoryReadFailed"),
    );
  }

  return {
    files: body.files,
    revision: await loadProjectRevision(projectId, translate),
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

async function loadProjectRevision(
  projectId: string,
  translate: (key: string) => string,
): Promise<number> {
  const response = await fetch(`/api/projects/${projectId}`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as {
    project?: ProjectDescription;
    error?: { message?: string };
  };

  if (!response.ok || !body.project) {
    throw new Error(
      body.error?.message ?? translate("publish.projectRevisionReadFailed"),
    );
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

type ShowcaseAdminCase = {
  id: string;
  projectId: string | null;
  title: string;
  slug: string;
  description: string | null;
  coverUrl: string | null;
  sortOrder: number;
  status: "draft" | "published" | "revoked";
  artifact: {
    sourceRevision: number;
  } | null;
};

type CandidateState = {
  phase: "idle" | "loading" | "success" | "failed" | "blocked";
  message: string;
  detail: string;
};
