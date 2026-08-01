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
            创建一份干净的 Repository，再由你或 Agent 写入第一版代码。Preview
            只会在需要运行时准备环境。
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
            <p>选择一种 Repository。Browser Git 只保存在当前浏览器中。</p>
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
                  Database
                </b>
                <span className="radio" />
              </div>
              <p>代码保存在 PostgreSQL，刷新和跨会话访问时可恢复当前项目。</p>
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
                <span className="storage-coming-soon">Local only</span>
              </div>
              <p>
                完整 Git 暂存、提交和历史保存在当前浏览器，清理站点数据会丢失。
              </p>
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
          <p className="field-hint">
            Blank 不会预置示例文件；第一笔保存或 Agent 修改将创建 revision 1。
          </p>
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
