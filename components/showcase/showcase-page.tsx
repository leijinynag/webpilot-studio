import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import type { ShowcaseCaseView } from "@/infrastructure/showcase/repository";

export function ShowcasePage({
  cases,
}: {
  cases: ShowcaseCaseView[];
}) {
  return (
    <div className="showcase-page page-in">
      <div className="showcase-head">
        <div>
          <div className="eyebrow">Built with WebPilot</div>
          <h1 className="font-editorial showcase-title">
            Ideas, made
            <br />
            visible.
          </h1>
        </div>
        <div className="showcase-copy">
          <p>
            探索从一句描述开始、经过真实运行和浏览器验证后发布的作品。每个案例都可以打开预览、查看代码与生成过程。
          </p>
          <div className="filter-row">
            <b>Featured</b>
            <span>New</span>
            <span>Products</span>
            <span>Portfolios</span>
            <span>Experiments</span>
          </div>
        </div>
      </div>

      {cases.length === 0 ? (
        <div className="showcase-empty">
          <b>还没有公开案例</b>
          <span>完成构建并发布后，作品会出现在这里。</span>
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
                  <span>{item.description ?? "Web project"}</span>
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
