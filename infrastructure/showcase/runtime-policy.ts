export const SHOWCASE_RUNTIME_ROUTE_PREFIX = "/showcase/runtime/";
export const SHOWCASE_RUNTIME_HEALTH_PATH = "/health";

import type { Locale } from "@/infrastructure/i18n/locale";

/**
 * 第二个 Vercel Project 只提供不可变 artifact Runtime。
 * Next 内部静态资源仍然需要放行，否则 iframe 的脚本和样式无法加载。
 */
export function isShowcaseRuntimeOnlyPath(pathname: string): boolean {
  return (
    pathname.startsWith(SHOWCASE_RUNTIME_ROUTE_PREFIX) ||
    pathname === SHOWCASE_RUNTIME_HEALTH_PATH ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico"
  );
}

/**
 * Runtime 的 CSP 只允许构建产物在自身 origin 内运行。
 * parent origin 是唯一额外的 frame ancestor，不能扩大脚本、网络或表单权限。
 */
export function buildShowcaseRuntimeCsp(parentOrigin?: string): string {
  const normalizedParentOrigin = parentOrigin?.replace(/\/$/, "");

  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors 'self'${normalizedParentOrigin ? ` ${normalizedParentOrigin}` : ""}`,
  ].join("; ");
}

export function getShowcaseRuntimeCacheControl(isEntry: boolean): string {
  return isEntry
    ? "no-store, max-age=0"
    : "public, max-age=31536000, immutable";
}

/**
 * Runtime-only 项目的根路径不是 Showcase 入口，而是部署说明页。
 * 说明页使用纯 HTML，不依赖主站组件、数据库或运行时脚本，避免误把
 * Runtime 部署当成完整 WebPilot Studio 暴露出去。
 */
export function buildShowcaseRuntimeLandingHtml(
  locale: Locale,
  siteUrl?: string,
): string {
  const copy =
    locale === "en"
      ? {
          lang: "en-US",
          title: "Showcase Runtime",
          description:
            "This deployment serves immutable published Showcase artifacts only.",
          detail:
            "Open a published Showcase URL to view a project. The Studio and its APIs are hosted separately.",
          linkLabel: "Open WebPilot Studio",
        }
      : {
          lang: "zh-CN",
          title: "Showcase Runtime",
          description: "该部署仅提供不可变的 Showcase 发布产物。",
          detail:
            "请打开具体的 Showcase 地址查看项目。Studio 主站和 API 部署在独立域名。",
          linkLabel: "打开 WebPilot Studio",
        };
  const safeSiteUrl = siteUrl ? escapeHtml(siteUrl) : null;
  const link = safeSiteUrl
    ? `<p><a href="${safeSiteUrl}">${copy.linkLabel}</a></p>`
    : "";

  return `<!doctype html>
<html lang="${copy.lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${copy.title}</title>
  </head>
  <body>
    <main>
      <h1>${copy.title}</h1>
      <p>${copy.description}</p>
      <p>${copy.detail}</p>
      ${link}
    </main>
  </body>
</html>`;
}

export function getShowcaseRuntimeLandingHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}
