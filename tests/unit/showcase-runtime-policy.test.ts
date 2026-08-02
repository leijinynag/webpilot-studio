import { describe, expect, it } from "vitest";

import {
  buildShowcaseRuntimeLandingHtml,
  buildShowcaseRuntimeCsp,
  getShowcaseRuntimeCacheControl,
  getShowcaseRuntimeLandingHeaders,
  isShowcaseRuntimeOnlyPath,
  SHOWCASE_RUNTIME_HEALTH_PATH,
} from "@/infrastructure/showcase/runtime-policy";

describe("Showcase Runtime deployment policy", () => {
  it("只放行 Runtime 和 Next 静态资源路径", () => {
    expect(
      isShowcaseRuntimeOnlyPath("/showcase/runtime/artifact/index.html"),
    ).toBe(true);
    expect(isShowcaseRuntimeOnlyPath(SHOWCASE_RUNTIME_HEALTH_PATH)).toBe(true);
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

  it("Runtime 根路径返回不依赖脚本的中英文部署说明页", () => {
    const chinese = buildShowcaseRuntimeLandingHtml(
      "zh",
      "https://webpilot.example.com/?a=1&b=2",
    );
    const english = buildShowcaseRuntimeLandingHtml("en");

    expect(chinese).toContain('<html lang="zh-CN">');
    expect(chinese).toContain("该部署仅提供不可变的 Showcase 发布产物。");
    expect(chinese).toContain("https://webpilot.example.com/?a=1&amp;b=2");
    expect(chinese).not.toContain("<script");
    expect(english).toContain('<html lang="en-US">');
    expect(english).toContain(
      "This deployment serves immutable published Showcase artifacts only.",
    );
    expect(english).not.toContain("Open WebPilot Studio");
  });

  it("Runtime 根路径使用 no-store、nosniff 和禁止嵌入的 CSP", () => {
    const headers = getShowcaseRuntimeLandingHeaders();

    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers["Content-Security-Policy"]).toContain("style-src 'none'");
  });
});
