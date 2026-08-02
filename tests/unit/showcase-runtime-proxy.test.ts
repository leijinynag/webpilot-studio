import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

function createRequest(pathname: string, headers?: HeadersInit): NextRequest {
  return new NextRequest(`https://webpilot-showcase.vercel.app${pathname}`, {
    headers,
  });
}

describe("Showcase Runtime proxy boundary", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANON_SESSION_SECRET", "test-secret-that-is-long-enough-for-proxy");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://webpilot-studio.vercel.app");
    vi.stubEnv("SHOWCASE_RUNTIME_ONLY", "true");
  });

  it("Runtime-only 根路径返回部署说明页，且不签发主站匿名 Cookie", async () => {
    const response = proxy(
      createRequest("/", {
        "accept-language": "en-US,en;q=0.9",
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    expect(body).toContain("Showcase Runtime");
    expect(body).toContain(
      "This deployment serves immutable published Showcase artifacts only.",
    );
  });

  it("Runtime 路由和 Next 静态资源继续放行", () => {
    const runtimeResponse = proxy(
      createRequest("/showcase/runtime/00000000-0000-4000-8000-000000000000/"),
    );
    const nextResponse = proxy(createRequest("/_next/static/chunk.js"));

    expect(runtimeResponse.headers.get("x-middleware-next")).toBe("1");
    expect(runtimeResponse.headers.get("set-cookie")).toBeNull();
    expect(nextResponse.headers.get("x-middleware-next")).toBe("1");
    expect(nextResponse.headers.get("set-cookie")).toBeNull();
  });

  it("主站关闭 Runtime-only 后才会建立匿名会话", () => {
    vi.stubEnv("SHOWCASE_RUNTIME_ONLY", "");

    const response = proxy(createRequest("/"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("set-cookie")).toContain(
      "webpilot-anonymous=",
    );
  });
});
