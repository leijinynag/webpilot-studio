import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import {
  createCsrfToken,
  getRequestOrigin,
  REQUEST_SECURITY_ERROR_CODES,
  shouldProtectBrowserMutation,
  validateBrowserMutation,
} from "@/infrastructure/http/request-security";

describe("request security", () => {
  it("creates an opaque 256-bit CSRF token", () => {
    const first = createCsrfToken();
    const second = createCsrfToken();

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it("protects browser API mutations but exempts platform callbacks", () => {
    expect(
      shouldProtectBrowserMutation({
        pathname: "/api/agent-runs",
        method: "POST",
      }),
    ).toBe(true);
    expect(
      shouldProtectBrowserMutation({
        pathname: "/api/projects",
        method: "GET",
      }),
    ).toBe(false);
    expect(
      shouldProtectBrowserMutation({
        pathname: "/api/queue/image-generation",
        method: "POST",
      }),
    ).toBe(false);
    expect(
      shouldProtectBrowserMutation({
        pathname: "/api/showcase/admin/publish",
        method: "POST",
      }),
    ).toBe(false);
  });

  it("rejects cross-origin mutations before checking the token", () => {
    const token = createCsrfToken();
    expect(
      validateBrowserMutation({
        requestOrigin: "https://attacker.example",
        expectedOrigin: "https://studio.example",
        csrfCookie: token,
        csrfHeader: token,
      }),
    ).toEqual({
      ok: false,
      code: REQUEST_SECURITY_ERROR_CODES.originRejected,
      message: "请求来源不受信任。",
    });
  });

  it("requires matching valid cookie and header tokens", () => {
    const token = createCsrfToken();
    expect(
      validateBrowserMutation({
        requestOrigin: "https://studio.example",
        expectedOrigin: "https://studio.example",
        csrfCookie: token,
        csrfHeader: token,
      }),
    ).toEqual({ ok: true });

    expect(
      validateBrowserMutation({
        requestOrigin: "https://studio.example",
        expectedOrigin: "https://studio.example",
        csrfCookie: token,
        csrfHeader: createCsrfToken(),
      }),
    ).toMatchObject({
      ok: false,
      code: REQUEST_SECURITY_ERROR_CODES.csrfRejected,
    });
  });

  it("优先使用 forwarded host/proto 计算反向代理后的 origin", () => {
    const request = new NextRequest(
      "http://localhost:3100/api/projects",
      {
        headers: {
          host: "localhost:3100",
          "x-forwarded-host": "studio.example",
          "x-forwarded-proto": "https",
        },
      },
    );

    expect(getRequestOrigin(request)).toBe("https://studio.example");
  });
});
