import "server-only";

import { cookies } from "next/headers";

import {
  createAnonymousSession,
  getAnonymousSessionCookieName,
  getAnonymousSessionCookieOptions,
  verifyAnonymousSession,
} from "@/domains/auth/anonymous-session";

/**
 * Server Component 只能读取 Cookie，不能在渲染过程中补写 Cookie。
 * 页面请求会先经过 proxy 签发会话，因此这里缺失时返回 null，由路由决定展示 404。
 */
export async function readRequestOwner(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookieName = getAnonymousSessionCookieName();
  const existing = verifyAnonymousSession(cookieStore.get(cookieName)?.value);

  return existing?.ownerId ?? null;
}

/**
 * Route Handler 的 owner 只来自签名 Cookie。请求 body、query 和 header
 * 即使包含 ownerId 也完全不会参与身份判断，避免越权读取其他匿名空间。
 */
export async function requireRequestOwner(): Promise<string> {
  const existingOwnerId = await readRequestOwner();

  if (existingOwnerId) {
    return existingOwnerId;
  }

  const cookieStore = await cookies();
  const cookieName = getAnonymousSessionCookieName();
  const created = createAnonymousSession();
  cookieStore.set(
    cookieName,
    created.cookieValue,
    getAnonymousSessionCookieOptions(),
  );

  return created.session.ownerId;
}
