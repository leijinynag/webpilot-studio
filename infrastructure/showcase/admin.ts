import "server-only";

import { timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/infrastructure/env/server";

/**
 * Showcase 管理接口不复用匿名 owner Cookie。
 * 这是一条独立的发布边界，后续可以替换成 Vercel SSO 或组织权限，
 * 而不会把普通访客的会话权限意外扩大为发布权限。
 */
export function isShowcaseAdminRequest(request: Request): boolean {
  const configuredToken = serverEnv.SHOWCASE_ADMIN_TOKEN?.trim();
  const providedToken =
    request.headers.get("x-showcase-admin-token") ??
    readBearerToken(request.headers.get("authorization"));

  if (!configuredToken || !providedToken) {
    return false;
  }

  const expected = Buffer.from(configuredToken);
  const actual = Buffer.from(providedToken);

  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

function readBearerToken(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
}

