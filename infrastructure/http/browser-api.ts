const CSRF_HEADER_NAME = "x-webpilot-csrf";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 浏览器访问主站 API 的统一 fetch 入口。
 *
 * 读取类请求保持原样；同源写请求自动把 double-submit CSRF Cookie 复制到
 * Header。调用方不接触 token 生成和轮换细节，也不会把 token 发给外部 URL。
 */
export function browserApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();

  if (
    typeof window === "undefined" ||
    !MUTATION_METHODS.has(method) ||
    !isSameOriginRequest(input)
  ) {
    return fetch(input, init);
  }

  const csrfToken = readCsrfCookie();
  if (!csrfToken) {
    return fetch(input, init);
  }

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(CSRF_HEADER_NAME, csrfToken);

  return fetch(input, {
    ...init,
    headers,
  });
}

function isSameOriginRequest(input: RequestInfo | URL): boolean {
  const rawUrl =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;

  try {
    return (
      new URL(rawUrl, window.location.href).origin === window.location.origin
    );
  } catch {
    return false;
  }
}

/**
 * 客户端必须和 Proxy 使用完全相同的 Cookie 命名规则。
 *
 * 浏览器可能同时保留线上 `__Host-` Cookie 与本地开发 Cookie。如果按固定
 * 优先级遍历，localhost 会误把线上旧值放进 Header，最终形成无法靠刷新恢复的
 * CSRF_REJECTED。构建环境在客户端会被 Next 内联，因此这里只读取唯一目标项。
 */
export function getBrowserCsrfCookieName(
  nodeEnv = process.env.NODE_ENV,
): "__Host-webpilot-csrf" | "webpilot-csrf" {
  return nodeEnv === "production" ? "__Host-webpilot-csrf" : "webpilot-csrf";
}

function readCsrfCookie(): string | null {
  const cookieName = getBrowserCsrfCookieName();
  const prefix = `${cookieName}=`;
  const cookies = document.cookie.split(";");
  const match = cookies
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix));

  if (match) {
    return decodeURIComponent(match.slice(prefix.length));
  }

  return null;
}
