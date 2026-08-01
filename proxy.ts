import { NextRequest, NextResponse } from "next/server";

import {
  createAnonymousSession,
  getAnonymousSessionCookieName,
  getAnonymousSessionCookieOptions,
  verifyAnonymousSession,
} from "@/domains/auth/anonymous-session";
import { isShowcaseRuntimeOnlyPath } from "@/infrastructure/showcase/runtime-policy";

/**
 * 页面首次访问即签发匿名会话，使后续客户端 API 请求可以直接恢复工作区。
 * API Route 仍会独立验证 Cookie；Proxy 不是授权边界，只负责尽早建立会话。
 */
export function proxy(request: NextRequest) {
  // 独立 Showcase Project 不应暴露主站页面、Agent API 或管理员入口。
  // _next 资源由策略函数显式放行，Runtime iframe 仍可以加载自身的构建资源。
  if (
    process.env.SHOWCASE_RUNTIME_ONLY === "true" &&
    !isShowcaseRuntimeOnlyPath(request.nextUrl.pathname)
  ) {
    return NextResponse.json(
      {
        error: {
          code: "SHOWCASE_RUNTIME_ONLY",
          message: "该部署仅提供 Showcase Runtime。",
        },
      },
      {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  // Showcase Runtime 使用独立域名部署，不需要匿名 owner 身份。主站 host-only
  // Cookie 不会跨域发送，这里也不在 Runtime 域名额外签发无意义的会话 Cookie。
  if (isShowcaseRuntimeOnlyPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const cookieName = getAnonymousSessionCookieName();
  const existing = verifyAnonymousSession(
    request.cookies.get(cookieName)?.value,
  );

  if (existing) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  const created = createAnonymousSession();
  response.cookies.set(
    cookieName,
    created.cookieValue,
    getAnonymousSessionCookieOptions(),
  );

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
