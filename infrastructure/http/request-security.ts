import type { NextRequest } from "next/server";

const CSRF_TOKEN_BYTES = 32;
const CSRF_HEADER_NAME = "x-webpilot-csrf";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const REQUEST_SECURITY_ERROR_CODES = {
  originRejected: "ORIGIN_REJECTED",
  csrfRejected: "CSRF_REJECTED",
} as const;

export type RequestSecurityErrorCode =
  (typeof REQUEST_SECURITY_ERROR_CODES)[keyof typeof REQUEST_SECURITY_ERROR_CODES];

export function getCsrfCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-webpilot-csrf"
    : "webpilot-csrf";
}

export function getCsrfCookieOptions() {
  return {
    httpOnly: false,
    maxAge: 60 * 60 * 24,
    path: "/",
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

/**
 * CSRF token 使用独立随机值，而不是从 ownerId 或会话签名派生。
 *
 * Cookie 对浏览器脚本可读，以便同源 fetch 复制到自定义 Header；攻击站点
 * 无法读取 host-only Cookie，也无法通过普通 HTML form 伪造自定义 Header。
 */
export function createCsrfToken(): string {
  const bytes = new Uint8Array(CSRF_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function isMutationMethod(method: string): boolean {
  return MUTATION_METHODS.has(method.toUpperCase());
}

export function shouldProtectBrowserMutation(input: {
  pathname: string;
  method: string;
}): boolean {
  if (!isMutationMethod(input.method) || !input.pathname.startsWith("/api/")) {
    return false;
  }

  // Queue Callback 由 Vercel Queue 的平台签名保护，不携带浏览器 Cookie。
  // Showcase Admin 使用独立 Bearer/管理 Token，也不依赖匿名 owner 会话。
  return (
    !input.pathname.startsWith("/api/queue/") &&
    !input.pathname.startsWith("/api/showcase/admin/")
  );
}

export function validateBrowserMutation(input: {
  requestOrigin: string | null;
  expectedOrigin: string;
  csrfCookie: string | null | undefined;
  csrfHeader: string | null;
}):
  | { ok: true }
  | {
      ok: false;
      code: RequestSecurityErrorCode;
      message: string;
    } {
  if (input.requestOrigin !== input.expectedOrigin) {
    return {
      ok: false,
      code: REQUEST_SECURITY_ERROR_CODES.originRejected,
      message: "请求来源不受信任。",
    };
  }

  if (
    !isValidCsrfToken(input.csrfCookie) ||
    !isValidCsrfToken(input.csrfHeader) ||
    input.csrfCookie !== input.csrfHeader
  ) {
    return {
      ok: false,
      code: REQUEST_SECURITY_ERROR_CODES.csrfRejected,
      message: "安全令牌已失效，请刷新页面后重试。",
    };
  }

  return { ok: true };
}

export function getCsrfHeaderName(): string {
  return CSRF_HEADER_NAME;
}

/**
 * 计算当前请求真正使用的站点 origin。
 *
 * Vercel/反向代理会通过 forwarded headers 保留外部协议和域名；本地
 * Next 开发服务器有时会把 request.nextUrl.host 规范化为 localhost，
 * 所以回退顺序必须优先使用请求的 Host，而不是只读取 nextUrl.origin。
 */
export function getRequestOrigin(request: NextRequest): string {
  const protocol =
    getFirstForwardedValue(request.headers.get("x-forwarded-proto")) ??
    request.nextUrl.protocol.replace(/:$/, "") ??
    "http";
  const host =
    getFirstForwardedValue(request.headers.get("x-forwarded-host")) ??
    request.headers.get("host") ??
    request.nextUrl.host;

  return `${protocol}://${host}`;
}

function isValidCsrfToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function getFirstForwardedValue(value: string | null): string | null {
  const first = value?.split(",")[0]?.trim();
  return first || null;
}
