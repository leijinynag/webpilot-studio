import { describe, expect, it } from "vitest";

import {
  buildShowcaseRuntimeCsp,
  getShowcaseRuntimeCacheControl,
  isShowcaseRuntimeOnlyPath,
} from "@/infrastructure/showcase/runtime-policy";

describe("Showcase Runtime deployment policy", () => {
  it("只放行 Runtime 和 Next 静态资源路径", () => {
    expect(
      isShowcaseRuntimeOnlyPath("/showcase/runtime/artifact/index.html"),
    ).toBe(true);
    expect(isShowcaseRuntimeOnlyPath("/_next/static/chunk.js")).toBe(true);
    expect(isShowcaseRuntimeOnlyPath("/favicon.ico")).toBe(true);
    expect(isShowcaseRuntimeOnlyPath("/")).toBe(false);
    expect(isShowcaseRuntimeOnlyPath("/api/showcase")).toBe(false);
    expect(isShowcaseRuntimeOnlyPath("/p/project-id")).toBe(false);
  });

  it("CSP 只允许自身资源和主站嵌入，不开放网络或表单", () => {
    const policy = buildShowcaseRuntimeCsp("https://webpilot.example.com/");

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain(
      "frame-ancestors 'self' https://webpilot.example.com",
    );
    expect(policy).not.toContain("SHOWCASE_ADMIN_TOKEN");
  });

  it("入口不缓存，静态资源使用长期不可变缓存", () => {
    expect(getShowcaseRuntimeCacheControl(true)).toBe("no-store, max-age=0");
    expect(getShowcaseRuntimeCacheControl(false)).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});
