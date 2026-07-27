import { NextRequest, NextResponse } from "next/server";

import {
  createAnonymousSession,
  getAnonymousSessionCookieName,
  getAnonymousSessionCookieOptions,
  verifyAnonymousSession,
} from "@/domains/auth/anonymous-session";

/**
 * 页面首次访问即签发匿名会话，使后续客户端 API 请求可以直接恢复工作区。
 * API Route 仍会独立验证 Cookie；Proxy 不是授权边界，只负责尽早建立会话。
 */
export function proxy(request: NextRequest) {
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
