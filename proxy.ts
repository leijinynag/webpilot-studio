import { NextRequest, NextResponse } from "next/server";

import {
  createAnonymousSession,
  getAnonymousSessionCookieName,
  getAnonymousSessionCookieOptions,
  verifyAnonymousSession,
} from "@/domains/auth/anonymous-session";
import {
  LOCALE_COOKIE_NAME,
  resolveLocale,
} from "@/infrastructure/i18n/locale";
import { isShowcaseRuntimeOnlyPath } from "@/infrastructure/showcase/runtime-policy";
import {
  buildShowcaseRuntimeLandingHtml,
  getShowcaseRuntimeLandingHeaders,
} from "@/infrastructure/showcase/runtime-policy";
import {
  createCsrfToken,
  getCsrfCookieName,
  getCsrfCookieOptions,
  getCsrfHeaderName,
  getRequestOrigin,
  shouldProtectBrowserMutation,
  validateBrowserMutation,
} from "@/infrastructure/http/request-security";

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
    const locale = resolveLocale({
      cookie: request.cookies.get(LOCALE_COOKIE_NAME)?.value,
      acceptLanguage: request.headers.get("accept-language"),
    });
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;

    return new NextResponse(buildShowcaseRuntimeLandingHtml(locale, siteUrl), {
      status: 404,
      headers: getShowcaseRuntimeLandingHeaders(),
    });
  }

  // Showcase Runtime 使用独立域名部署，不需要匿名 owner 身份。主站 host-only
  // Cookie 不会跨域发送，这里也不在 Runtime 域名额外签发无意义的会话 Cookie。
  if (isShowcaseRuntimeOnlyPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const cookieName = getAnonymousSessionCookieName();
  const csrfCookieName = getCsrfCookieName();
  const existing = verifyAnonymousSession(
    request.cookies.get(cookieName)?.value,
  );
  const existingCsrfToken = request.cookies.get(csrfCookieName)?.value;
  const protectsMutation = shouldProtectBrowserMutation({
    pathname: request.nextUrl.pathname,
    method: request.method,
  });

  if (protectsMutation) {
    const validation = validateBrowserMutation({
      requestOrigin: request.headers.get("origin"),
      // Next 本地开发服务器可能把 127.0.0.1 规范化成 localhost；
      // CSRF 校验应以实际 Host 为准，否则同一个页面的同源写请求会被误拒绝。
      expectedOrigin: getRequestOrigin(request),
      csrfCookie: existingCsrfToken,
      csrfHeader: request.headers.get(getCsrfHeaderName()),
    });

    // 写请求必须建立在已经签发的匿名会话上。否则直接访问 API 会在
    // Route Handler 中创建新 owner，从而绕过 double-submit token 的首轮校验。
    if (!existing) {
      const response = NextResponse.json(
        {
          error: {
            code: "CSRF_REJECTED",
            message: "匿名会话尚未建立，请刷新页面后重试。",
          },
        },
        { status: 403 },
      );

      // CSRF Cookie 被用户单独清除时，在拒绝响应中补发新 token。
      // 客户端刷新后即可恢复，不需要清除仍然有效的匿名项目 Cookie。
      if (!existingCsrfToken) {
        response.cookies.set(
          csrfCookieName,
          createCsrfToken(),
          getCsrfCookieOptions(),
        );
      }
      return response;
    }

    if (!validation.ok) {
      const response = NextResponse.json(
        {
          error: {
            code: validation.code,
            message: validation.message,
          },
        },
        { status: 403 },
      );

      // CSRF Cookie 被用户单独清除时，在拒绝响应中补发新 token。
      // 客户端刷新后即可恢复，不需要清除仍然有效的匿名项目 Cookie。
      if (!existingCsrfToken) {
        response.cookies.set(
          csrfCookieName,
          createCsrfToken(),
          getCsrfCookieOptions(),
        );
      }
      return response;
    }
  }

  if (existing && existingCsrfToken) {
    return NextResponse.next();
  }

  const response = NextResponse.next();
  if (!existing) {
    const created = createAnonymousSession();
    response.cookies.set(
      cookieName,
      created.cookieValue,
      getAnonymousSessionCookieOptions(),
    );
  }
  if (!existingCsrfToken) {
    response.cookies.set(
      csrfCookieName,
      createCsrfToken(),
      getCsrfCookieOptions(),
    );
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
