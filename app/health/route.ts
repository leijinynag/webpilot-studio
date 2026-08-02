import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * 健康探针只返回部署角色和构建标识，不读取数据库、Blob 或任何敏感配置。
 * Runtime-only 项目允许该入口通过 Proxy，便于区分“主站域名”和“Showcase
 * Runtime 域名”是否命中了预期部署，而不会因为根路径的 404 说明页产生歧义。
 */
export function GET() {
  // 健康探针只读取部署角色这一项公开布尔配置，避免引入完整 serverEnv
  // 校验和 server-only 依赖。其它环境变量绝不能从这里被序列化返回。
  const runtimeOnly = process.env.SHOWCASE_RUNTIME_ONLY === "true";

  return NextResponse.json(
    {
      ok: true,
      service: "webpilot-studio",
      deployment: runtimeOnly ? "showcase-runtime" : "primary",
      runtimeOnly,
      build: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
