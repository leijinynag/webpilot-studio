"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import type { ShowcaseCaseView } from "@/infrastructure/showcase/repository";
import { useUiI18n } from "@/infrastructure/i18n/ui";

export function ShowcasePage({ cases }: { cases: ShowcaseCaseView[] }) {
  const { t } = useUiI18n();

  return (
    <div className="showcase-page page-in">
      <div className="showcase-head">
        <div>
          <div className="eyebrow">{t("showcase.eyebrow")}</div>
          <h1 className="font-editorial showcase-title">
            {t("showcase.title")
              .split("\n")
              .map((line) => (
                <span key={line}>
                  {line}
                  <br />
                </span>
              ))}
          </h1>
        </div>
        <div className="showcase-copy">
          <p>{t("showcase.description")}</p>
          <div className="filter-row">
            <b>{t("showcase.featured")}</b>
            <span>{t("showcase.new")}</span>
            <span>{t("showcase.products")}</span>
            <span>{t("showcase.portfolios")}</span>
            <span>{t("showcase.experiments")}</span>
          </div>
        </div>
      </div>

      {cases.length === 0 ? (
        <div className="showcase-empty">
          <b>{t("showcase.emptyTitle")}</b>
          <span>{t("showcase.emptyDescription")}</span>
        </div>
      ) : (
        <div className="showcase-grid">
          {cases.map((item) => (
            <Link
              className="showcase-piece"
              href={`/showcase/${item.slug}`}
              key={item.id}
            >
              <div className="piece-art">
                {item.coverUrl ? (
                  // 封面来自管理员发布元数据，Runtime 仍然只负责 artifact。
                  // 这里不使用 next/image，因为封面域名由管理员配置，不能把任意
                  // 公开域名加入主站的图片优化白名单。
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="" src={item.coverUrl} />
                ) : (
                  <div className="piece-window">
                    <span>WEBPILOT SHOWCASE</span>
                    <h3>{item.title}</h3>
                  </div>
                )}
              </div>
              <div className="piece-info">
                <div>
                  <b>{item.title}</b>
                  <span>{item.description ?? t("showcase.webProject")}</span>
                </div>
                <span className="piece-arrow">
                  <ArrowUpRight />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
