export const SHOWCASE_RUNTIME_ROUTE_PREFIX = "/showcase/runtime/";

/**
 * 第二个 Vercel Project 只提供不可变 artifact Runtime。
 * Next 内部静态资源仍然需要放行，否则 iframe 的脚本和样式无法加载。
 */
export function isShowcaseRuntimeOnlyPath(pathname: string): boolean {
  return (
    pathname.startsWith(SHOWCASE_RUNTIME_ROUTE_PREFIX) ||
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
