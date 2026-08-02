"use client";

import Link from "next/link";
import { ArrowRight, Database, GitBranch, LoaderCircle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ProjectDescription } from "@/domains/project/types";
import { useUiI18n } from "@/infrastructure/i18n/ui";

const templates = [
  { name: "Blank", className: "blank", available: true },
  { name: "Dashboard", className: "dashboard", available: false },
  { name: "Landing", className: "landing", available: false },
  { name: "Portfolio", className: "portfolio", available: false },
] as const;

type CreateProjectResponse = {
  project?: ProjectDescription;
  error?: {
    message?: string;
  };
};

export function NewProjectPage() {
  const router = useRouter();
  const { t } = useUiI18n();
  const [name, setName] = useState("Untitled project");
  const [storageKind, setStorageKind] = useState<"database" | "browser_git">(
    "database",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          storageKind,
          template: "empty",
        }),
      });
      const body = (await response.json()) as CreateProjectResponse;

      if (!response.ok || !body.project) {
        throw new Error(body.error?.message ?? t("newProject.createFailed"));
      }

      // 使用服务端生成的 UUID 只导航一次；Browser Git 首次 provision claim
      // 必须保持单次消费，避免额外 refresh 造成第二次初始化竞态。
      router.push(`/p/${body.project.id}`);
    } catch (creationError) {
      setError(
        creationError instanceof Error
          ? creationError.message
          : t("newProject.createFailed"),
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="create-page page-in">
      <section className="create-intro">
        <div>
          <div className="eyebrow">{t("newProject.eyebrow")}</div>
          <h1 className="font-editorial create-title">
            {t("newProject.title")
              .split("\n")
              .map((line) => (
                <span key={line}>
                  {line}
                  <br />
                </span>
              ))}
          </h1>
          <p className="create-lede">{t("newProject.lede")}</p>
        </div>
        <div className="create-steps" aria-label={t("newProject.steps")}>
          <i className="active" />
          <i />
          <i />
        </div>
      </section>

      <form className="create-form" onSubmit={createProject}>
        <div className="form-heading">
          <div>
            <h2 className="font-editorial">{t("newProject.setup")}</h2>
            <p>{t("newProject.repositoryHint")}</p>
          </div>
          <Button
            aria-label={t("newProject.close")}
            asChild
            size="icon-sm"
            variant="ghost"
          >
            <Link href="/">
              <X />
            </Link>
          </Button>
        </div>

        <div className="form-section">
          <label className="field-label" htmlFor="project-name">
            {t("newProject.name")}
          </label>
          <input
            autoFocus
            className="field"
            disabled={submitting}
            id="project-name"
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </div>

        <div className="form-section">
          <span className="field-label">{t("newProject.repository")}</span>
          <div className="storage-options">
            <button
              aria-pressed={storageKind === "database"}
              className={`storage-option ${
                storageKind === "database" ? "active" : ""
              }`}
              onClick={() => setStorageKind("database")}
              type="button"
            >
              <div className="storage-option-head">
                <b>
                  <Database />
                  {t("newProject.database")}
                </b>
                <span className="radio" />
              </div>
              <p>{t("newProject.databaseHint")}</p>
            </button>
            <button
              aria-pressed={storageKind === "browser_git"}
              className={`storage-option ${
                storageKind === "browser_git" ? "active" : ""
              }`}
              onClick={() => setStorageKind("browser_git")}
              type="button"
            >
              <div className="storage-option-head">
                <b>
                  <GitBranch />
                  Browser Git
                </b>
                <span className="storage-coming-soon">
                  {t("newProject.localOnly")}
                </span>
              </div>
              <p>{t("newProject.browserGitHint")}</p>
            </button>
          </div>
        </div>

        <div className="form-section">
          <span className="field-label">{t("newProject.startingPoint")}</span>
          <div className="template-strip">
            {templates.map((template) => (
              <button
                className={`template ${
                  template.available ? "active" : "unavailable"
                }`}
                disabled={!template.available}
                key={template.name}
                type="button"
              >
                <div className={`template-preview ${template.className}`} />
                <span>
                  {template.name}
                  {!template.available ? ` · ${t("newProject.later")}` : ""}
                </span>
              </button>
            ))}
          </div>
          <p className="field-hint">{t("newProject.blankHint")}</p>
        </div>

        <div className="form-section">
          <label className="field-label" htmlFor="first-request">
            {t("newProject.firstRequest")}
          </label>
          <textarea
            className="field"
            disabled
            id="first-request"
            placeholder={t("newProject.firstRequestPlaceholder")}
          />
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="create-actions">
          <Button asChild variant="outline">
            <Link href="/">{t("newProject.cancel")}</Link>
          </Button>
          <Button
            className="app-button-accent"
            disabled={submitting || name.trim().length === 0}
            type="submit"
          >
            {submitting ? (
              <LoaderCircle className="project-state-spinner" />
            ) : null}
            {submitting ? t("newProject.creating") : t("newProject.create")}
            {!submitting ? <ArrowRight data-icon="inline-end" /> : null}
          </Button>
        </div>
      </form>
    </div>
  );
}
