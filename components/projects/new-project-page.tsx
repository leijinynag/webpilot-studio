"use client";

import Link from "next/link";
import { ArrowRight, Database, GitBranch, LoaderCircle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ProjectDescription } from "@/domains/project/types";

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
  const [name, setName] = useState("Untitled project");
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
          storageKind: "database",
          template: "rsbuild",
        }),
      });
      const body = (await response.json()) as CreateProjectResponse;

      if (!response.ok || !body.project) {
        throw new Error(body.error?.message ?? "项目创建失败，请稍后重试。");
      }

      // 使用服务端生成的 UUID 跳转；随后刷新仍由匿名 Cookie 找回同一个项目。
      router.push(`/p/${body.project.id}`);
      router.refresh();
    } catch (creationError) {
      setError(
        creationError instanceof Error
          ? creationError.message
          : "项目创建失败，请稍后重试。",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="create-page page-in">
      <section className="create-intro">
        <div>
          <div className="eyebrow">New project / 01</div>
          <h1 className="font-editorial create-title">
            Give the idea
            <br />a place to live.
          </h1>
          <p className="create-lede">
            选择代码保存方式和起点。项目创建后，Agent、编辑器、Preview 与 Source
            Control 会围绕同一份 Repository 工作。
          </p>
        </div>
        <div className="create-steps" aria-label="创建进度">
          <i className="active" />
          <i />
          <i />
        </div>
      </section>

      <form className="create-form" onSubmit={createProject}>
        <div className="form-heading">
          <div>
            <h2 className="font-editorial">Project setup</h2>
            <p>当前版本使用数据库持久化，Browser Git 将在后续里程碑接入。</p>
          </div>
          <Button
            aria-label="关闭新建项目"
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
            Project name
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
          <span className="field-label">Repository</span>
          <div className="storage-options">
            <button
              aria-pressed="true"
              className="storage-option active"
              type="button"
            >
              <div className="storage-option-head">
                <b>
                  <Database />
                  Database
                </b>
                <span className="radio" />
              </div>
              <p>代码保存在 PostgreSQL，刷新和跨会话访问时可恢复当前项目。</p>
            </button>
            <button
              aria-disabled="true"
              className="storage-option unavailable"
              disabled
              type="button"
            >
              <div className="storage-option-head">
                <b>
                  <GitBranch />
                  Browser Git
                </b>
                <span className="storage-coming-soon">Coming later</span>
              </div>
              <p>浏览器内完整 Git 暂存、提交、历史和分支将在后续里程碑开放。</p>
            </button>
          </div>
        </div>

        <div className="form-section">
          <span className="field-label">Starting point</span>
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
                  {!template.available ? " · Later" : ""}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="form-section">
          <label className="field-label" htmlFor="first-request">
            First request
          </label>
          <textarea
            className="field"
            disabled
            id="first-request"
            placeholder="Agent workflow will be connected in a later milestone."
          />
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="create-actions">
          <Button asChild variant="outline">
            <Link href="/">Cancel</Link>
          </Button>
          <Button
            className="app-button-accent"
            disabled={submitting || name.trim().length === 0}
            type="submit"
          >
            {submitting ? (
              <LoaderCircle className="project-state-spinner" />
            ) : null}
            {submitting ? "Creating..." : "Create project"}
            {!submitting ? <ArrowRight data-icon="inline-end" /> : null}
          </Button>
        </div>
      </form>
    </div>
  );
}
