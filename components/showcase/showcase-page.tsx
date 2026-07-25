import { ArrowUpRight } from "lucide-react";

const showcasePieces = [
  {
    title: "Still / Objects",
    detail: "Editorial commerce · by Guest Builder",
    className: "objects featured",
    windowTitle: "Objects for slower days.",
  },
  {
    title: "Atlas Finance",
    detail: "Dashboard",
    className: "finance",
  },
  {
    title: "Northwind Notes",
    detail: "Writing tool",
    className: "notes",
  },
  {
    title: "Studio Archive",
    detail: "Portfolio",
    className: "gallery",
  },
  {
    title: "Quiet Routes",
    detail: "Travel journal",
    className: "travel",
  },
] as const;

export function ShowcasePage() {
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

      <div className="showcase-grid">
        {showcasePieces.map((piece) => (
          <article
            className={`showcase-piece ${piece.className}`}
            key={piece.title}
          >
            <div className={`piece-art ${piece.className.split(" ")[0]}`}>
              <div className="piece-window">
                {"windowTitle" in piece ? (
                  <div>
                    <span>THE NEW COLLECTION</span>
                    <h3>{piece.windowTitle}</h3>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="piece-info">
              <div>
                <b>{piece.title}</b>
                <span>{piece.detail}</span>
              </div>
              <span className="piece-arrow">
                <ArrowUpRight />
              </span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
