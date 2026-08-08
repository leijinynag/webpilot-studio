// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import {
  createAnonymousSession,
  getAnonymousSessionCookieName,
} from "@/domains/auth/anonymous-session";
import {
  getCsrfCookieName,
  getCsrfHeaderName,
} from "@/infrastructure/http/request-security";
import { proxy } from "@/proxy";

const TEST_ORIGIN = "https://studio.example";
const TEST_SECRET = "proxy-test-secret-that-is-at-least-32-characters";

function createRequest(
  pathname: string,
  options: {
    origin?: string;
    method?: string;
    headers?: HeadersInit;
    cookies?: Record<string, string>;
  } = {},
) {
  const requestOrigin = options.origin ?? TEST_ORIGIN;
  const request = new NextRequest(`${requestOrigin}${pathname}`, {
    method: options.method,
    headers: options.headers,
  });

  for (const [name, value] of Object.entries(options.cookies ?? {})) {
    request.cookies.set(name, value);
  }

  return request;
}

function createBrowserCookies() {
  const session = createAnonymousSession(Date.now(), TEST_SECRET);
  const csrf = "a".repeat(64);

  return {
    [getAnonymousSessionCookieName()]: session.cookieValue,
    [getCsrfCookieName()]: csrf,
    csrf,
  };
}

describe("proxy browser security boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANON_SESSION_SECRET", TEST_SECRET);
    vi.stubEnv("SHOWCASE_RUNTIME_ONLY", "");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", TEST_ORIGIN);
  });

  it("首次 GET 签发 host-only 匿名会话和 CSRF Cookie", () => {
    const response = proxy(createRequest("/"));
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(setCookie).toContain("__Host-webpilot-anonymous=");
    expect(setCookie).toContain("__Host-webpilot-csrf=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("SameSite=strict");
    expect(setCookie).not.toContain("Domain=");
  });

  it("缺少 Origin 的浏览器 POST 返回 403", async () => {
    const cookies = createBrowserCookies();
    const response = proxy(
      createRequest("/api/projects", {
        method: "POST",
        cookies,
        headers: {
          [getCsrfHeaderName()]: cookies.csrf,
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ORIGIN_REJECTED" },
    });
  });

  it("错误 CSRF Header 返回 403", async () => {
    const cookies = createBrowserCookies();
    const response = proxy(
      createRequest("/api/projects", {
        method: "POST",
        cookies,
        headers: {
          origin: TEST_ORIGIN,
          [getCsrfHeaderName()]: "b".repeat(64),
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CSRF_REJECTED" },
    });
  });

  it("合法同源 POST 放行，且不会重复签发 Cookie", () => {
    const cookies = createBrowserCookies();
    const response = proxy(
      createRequest("/api/projects", {
        method: "POST",
        cookies,
        headers: {
          origin: TEST_ORIGIN,
          [getCsrfHeaderName()]: cookies.csrf,
        },
      }),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("本地 Host 与 NextURL 规范化 host 不同时仍按实际请求 origin 放行", () => {
    const cookies = createBrowserCookies();
    const request = createRequest("/api/projects", {
      origin: "http://127.0.0.1:3100",
      method: "POST",
      cookies,
      headers: {
        host: "127.0.0.1:3100",
        origin: "http://127.0.0.1:3100",
        [getCsrfHeaderName()]: cookies.csrf,
      },
    });

    const response = proxy(request);

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("平台回调和 Runtime-only 路径不走浏览器 CSRF 校验", () => {
    const queueResponse = proxy(
      createRequest("/api/queue/image-generation", {
        method: "POST",
      }),
    );
    const adminResponse = proxy(
      createRequest("/api/showcase/admin/publish", {
        method: "POST",
      }),
    );

    expect(queueResponse.headers.get("x-middleware-next")).toBe("1");
    expect(adminResponse.headers.get("x-middleware-next")).toBe("1");

    vi.stubEnv("SHOWCASE_RUNTIME_ONLY", "true");
    const runtimeResponse = proxy(
      createRequest("/showcase/runtime/00000000-0000-4000-8000-000000000000/"),
    );
    const blockedResponse = proxy(createRequest("/p/project-id"));

    expect(runtimeResponse.headers.get("x-middleware-next")).toBe("1");
    expect(runtimeResponse.headers.get("set-cookie")).toBeNull();
    expect(blockedResponse.status).toBe(404);
    expect(blockedResponse.headers.get("set-cookie")).toBeNull();
  });
});
