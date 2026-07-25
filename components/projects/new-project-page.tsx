import Link from "next/link";
import { ArrowRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";

const templates = [
  { name: "Blank", className: "blank" },
  { name: "Dashboard", className: "dashboard" },
  { name: "Landing", className: "landing" },
  { name: "Portfolio", className: "portfolio" },
];

export function NewProjectPage() {
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

      <section className="create-form">
        <div className="form-heading">
          <div>
            <h2 className="font-editorial">Project setup</h2>
            <p>这些设置稍后仍可调整，存储类型迁移会经过独立确认。</p>
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
            className="field"
            defaultValue="Untitled project"
            id="project-name"
          />
        </div>

        <div className="form-section">
          <span className="field-label">Repository</span>
          <div className="storage-options">
            <div className="storage-option active">
              <div className="storage-option-head">
                <b>Browser Git</b>
                <span className="radio" />
              </div>
              <p>
                代码保存在当前浏览器的 IndexedDB
                中，提供完整暂存、提交、历史和分支体验。
              </p>
            </div>
            <div className="storage-option">
              <div className="storage-option-head">
                <b>Database</b>
                <span className="radio" />
              </div>
              <p>
                代码保存在云端数据库，跨设备更方便；第一版不提供远程 Git 操作。
              </p>
            </div>
          </div>
        </div>

        <div className="form-section">
          <span className="field-label">Starting point</span>
          <div className="template-strip">
            {templates.map((template, index) => (
              <div
                className={`template ${index === 0 ? "active" : ""}`}
                key={template.name}
              >
                <div className={`template-preview ${template.className}`} />
                <span>{template.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="form-section">
          <label className="field-label" htmlFor="first-request">
            First request
          </label>
          <textarea
            className="field"
            defaultValue="Build a calm financial dashboard for independent creative studios. Use warm neutrals, clear comparison charts, and a compact mobile layout."
            id="first-request"
          />
        </div>

        <div className="create-actions">
          <Button asChild variant="outline">
            <Link href="/">Cancel</Link>
          </Button>
          <Button asChild className="app-button-accent">
            <Link href="/p/atlas-finance">
              Create and start
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
