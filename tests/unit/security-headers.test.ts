// @vitest-environment node

import { describe, expect, it } from "vitest";

import { getMainApplicationSecurityHeaders } from "@/infrastructure/http/security-headers";

function headerValue(
  headers: Array<{ key: string; value: string }>,
  key: string,
) {
  return headers.find((header) => header.key === key)?.value;
}

describe("main application security headers", () => {
  it("生产 CSP 保留 WebContainer、Monaco 和跨源 Preview 所需能力", () => {
    const headers = getMainApplicationSecurityHeaders(false);
    const csp = headerValue(headers, "Content-Security-Policy");

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' https: wss:");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-src 'self' https: blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("开发环境只额外开放 Next 开发编译器需要的 eval", () => {
    const headers = getMainApplicationSecurityHeaders(true);
    const csp = headerValue(headers, "Content-Security-Policy");

    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });

  it("补齐通用浏览器安全策略", () => {
    const headers = getMainApplicationSecurityHeaders(false);

    expect(headerValue(headers, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headerValue(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue(headers, "Permissions-Policy")).toContain(
      "camera=()",
    );
    expect(headerValue(headers, "Permissions-Policy")).toContain(
      "microphone=()",
    );
  });
});
