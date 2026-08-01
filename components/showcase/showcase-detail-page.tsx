import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";

import type { ShowcaseCaseView } from "@/infrastructure/showcase/repository";

export function ShowcaseDetailPage({
  item,
  runtimeOrigin,
}: {
  item: ShowcaseCaseView;
  runtimeOrigin?: string;
}) {
  const runtimeUrl = item.artifact
    ? `${runtimeOrigin ?? ""}/showcase/runtime/${item.artifact.id}/`
    : null;

  return (
    <main className="showcase-detail page-in">
      <div className="showcase-detail-head">
        <Link className="back-to-workbench" href="/showcase">
          <ArrowLeft data-icon="inline-start" />
          返回 Showcase
        </Link>
        <span className="eyebrow">Built with WebPilot</span>
      </div>

      <section className="showcase-detail-hero">
        <div className="showcase-detail-copy">
          <h1 className="font-editorial showcase-detail-title">{item.title}</h1>
          <p>{item.description ?? "一个经过构建和验证的 WebPilot 项目。"}</p>
          <div className="showcase-detail-meta">
            <span>{item.artifact?.fileCount ?? 0} assets</span>
            <span>revision {item.artifact?.sourceRevision ?? "-"}</span>
            <span>{item.slug}</span>
          </div>
          {runtimeUrl ? (
            <a
              className="showcase-runtime-link"
              href={runtimeUrl}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink data-icon="inline-start" />
              在新窗口打开预览
            </a>
          ) : null}
        </div>

        <div className="showcase-detail-preview">
          {runtimeUrl ? (
            <iframe
              allow="fullscreen"
              className="showcase-runtime-frame"
              loading="eager"
              src={runtimeUrl}
              title={`${item.title} 预览`}
            />
          ) : (
            <div className="showcase-empty">当前案例暂无可用 artifact。</div>
          )}
        </div>
      </section>
    </main>
  );
}
