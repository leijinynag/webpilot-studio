import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserApiFetch,
  getBrowserCsrfCookieName,
} from "@/infrastructure/http/browser-api";

const LOCAL_TOKEN = "a".repeat(64);
const PRODUCTION_TOKEN = "b".repeat(64);

describe("browserApiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("客户端 Cookie 名称与服务端构建环境保持一致", () => {
    expect(getBrowserCsrfCookieName("development")).toBe("webpilot-csrf");
    expect(getBrowserCsrfCookieName("test")).toBe("webpilot-csrf");
    expect(getBrowserCsrfCookieName("production")).toBe("__Host-webpilot-csrf");
  });

  it("开发环境双 Cookie 共存时只把本地 token 写入请求 Header", async () => {
    document.cookie = `__Host-webpilot-csrf=${PRODUCTION_TOKEN}; Path=/`;
    document.cookie = `webpilot-csrf=${LOCAL_TOKEN}; Path=/`;

    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await browserApiFetch("/api/projects", {
      method: "POST",
      body: "{}",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init?.headers).get("x-webpilot-csrf")).toBe(LOCAL_TOKEN);
  });
});
