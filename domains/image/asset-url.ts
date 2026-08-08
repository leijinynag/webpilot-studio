import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { ProjectAssetRow } from "@/infrastructure/db/schema";
import { getAnonymousSessionSigningSecret } from "@/domains/auth/anonymous-session";

const ASSET_URL_TTL_SECONDS = 15 * 60;
const ASSET_URL_MAX_TTL_SECONDS = 60 * 60;

export type SignedAssetRequest = {
  assetId: string;
  projectId: string;
  ownerId: string;
  expiresAt: number;
  signature: string;
};

/**
 * 生成签名输入时显式列出所有绑定字段，避免只签 assetId 导致签名被
 * 跨项目或跨 owner 重放。字段顺序是协议的一部分，后续修改必须升级版本。
 */
function buildSigningMessage(input: Omit<SignedAssetRequest, "signature">) {
  return [
    "webpilot-asset-v1",
    input.assetId,
    input.projectId,
    input.ownerId,
    String(input.expiresAt),
  ].join(".");
}

function signAssetRequest(
  input: Omit<SignedAssetRequest, "signature">,
): string {
  return createHmac("sha256", getAnonymousSessionSigningSecret())
    .update(buildSigningMessage(input))
    .digest("base64url");
}

export function createSignedAssetUrl(input: {
  asset: Pick<ProjectAssetRow, "id" | "projectId" | "ownerId">;
  now?: number;
  ttlSeconds?: number;
  baseUrl?: string;
}): string {
  const ttlSeconds = Math.min(
    Math.max(Math.floor(input.ttlSeconds ?? ASSET_URL_TTL_SECONDS), 1),
    ASSET_URL_MAX_TTL_SECONDS,
  );
  const expiresAt = Math.floor((input.now ?? Date.now()) / 1000) + ttlSeconds;
  const signedRequest = {
    assetId: input.asset.id,
    projectId: input.asset.projectId,
    ownerId: input.asset.ownerId,
    expiresAt,
  };
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? getAssetBaseUrl());
  const url = new URL(
    `/api/project-assets/${encodeURIComponent(input.asset.id)}/content`,
    baseUrl,
  );
  url.searchParams.set("projectId", input.asset.projectId);
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signAssetRequest(signedRequest));
  return url.toString();
}

export function verifySignedAssetRequest(
  input: SignedAssetRequest,
  now = Date.now(),
): boolean {
  if (!Number.isSafeInteger(input.expiresAt)) {
    return false;
  }

  const nowSeconds = Math.floor(now / 1000);
  if (input.expiresAt <= nowSeconds) {
    return false;
  }

  const expected = signAssetRequest({
    assetId: input.assetId,
    projectId: input.projectId,
    ownerId: input.ownerId,
    expiresAt: input.expiresAt,
  });
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(input.signature);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function getAssetBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    return configured;
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    return `https://${vercelUrl}`;
  }

  return "http://localhost:3000";
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
