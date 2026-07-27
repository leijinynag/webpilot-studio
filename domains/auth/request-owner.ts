import "server-only";

import { cookies } from "next/headers";

import {
  createAnonymousSession,
  getAnonymousSessionCookieName,
  getAnonymousSessionCookieOptions,
  verifyAnonymousSession,
} from "@/domains/auth/anonymous-session";

/**
 * Route Handler 的 owner 只来自签名 Cookie。请求 body、query 和 header
 * 即使包含 ownerId 也完全不会参与身份判断，避免越权读取其他匿名空间。
 */
export async function requireRequestOwner(): Promise<string> {
  const cookieStore = await cookies();
  const cookieName = getAnonymousSessionCookieName();
  const existing = verifyAnonymousSession(cookieStore.get(cookieName)?.value);

  if (existing) {
    return existing.ownerId;
  }

  const created = createAnonymousSession();
  cookieStore.set(
    cookieName,
    created.cookieValue,
    getAnonymousSessionCookieOptions(),
  );

  return created.session.ownerId;
}
