"use client";

import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";

import type { ShowcaseCaseView } from "@/infrastructure/showcase/repository";
import { useUiI18n } from "@/infrastructure/i18n/ui";

export function ShowcaseDetailPage({
  item,
  runtimeOrigin,
}: {
  item: ShowcaseCaseView;
  runtimeOrigin?: string;
}) {
  const { t } = useUiI18n();
  const runtimeUrl = item.artifact
    ? `${runtimeOrigin ?? ""}/showcase/runtime/${item.artifact.id}/`
    : null;

  return (
    <main className="showcase-detail page-in">
      <div className="showcase-detail-head">
        <Link className="back-to-workbench" href="/showcase">
          <ArrowLeft data-icon="inline-start" />
          {t("showcase.back")}
        </Link>
        <span className="eyebrow">{t("showcase.eyebrow")}</span>
      </div>

      <section className="showcase-detail-hero">
        <div className="showcase-detail-copy">
          <h1 className="font-editorial showcase-detail-title">{item.title}</h1>
          <p>{item.description ?? t("showcase.webProject")}</p>
          <div className="showcase-detail-meta">
            <span>
              {t("showcase.assets", { count: item.artifact?.fileCount ?? 0 })}
            </span>
            <span>
              {t("showcase.revision", {
                revision: item.artifact?.sourceRevision ?? "-",
              })}
            </span>
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
              {t("showcase.openPreview")}
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
              title={t("showcase.previewTitle", { title: item.title })}
            />
          ) : (
            <div className="showcase-empty">{t("showcase.noArtifact")}</div>
          )}
        </div>
      </section>
    </main>
  );
}
