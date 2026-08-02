import { beforeEach, describe, expect, it, vi } from "vitest";

// asset-url.ts 是服务端模块，生产环境需要 server-only 防止被客户端误导入。
// 这里仅测试其中的纯签名函数，因此在 Vitest 中隔离掉框架级导入约束。
vi.mock("server-only", () => ({}));

import {
  createSignedAssetUrl,
  verifySignedAssetRequest,
} from "@/domains/image/asset-url";

const ASSET = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  ownerId: "anonymous-owner-asset-test-000000000000000000000000",
} as const;

describe("project asset signed access", () => {
  beforeEach(() => {
    vi.stubEnv(
      "ANON_SESSION_SECRET",
      "asset-access-test-secret-that-is-long-enough",
    );
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://webpilot.example");
  });

  it("把 asset、project、owner 和过期时间绑定到受控 URL", () => {
    const url = createSignedAssetUrl({
      asset: ASSET,
      now: 1_754_070_000_000,
      ttlSeconds: 900,
    });
    const parsed = new URL(url);
    const expiresAt = Number(parsed.searchParams.get("exp"));

    expect(parsed.origin).toBe("https://webpilot.example");
    expect(parsed.pathname).toBe(
      `/api/project-assets/${ASSET.id}/content`,
    );
    expect(parsed.searchParams.get("projectId")).toBe(ASSET.projectId);
    expect(parsed.searchParams.get("sig")).toBeTruthy();
    expect(
      verifySignedAssetRequest({
        assetId: ASSET.id,
        projectId: ASSET.projectId,
        ownerId: ASSET.ownerId,
        expiresAt,
        signature: parsed.searchParams.get("sig") ?? "",
      }, 1_754_070_000_000),
    ).toBe(true);
  });

  it("拒绝跨项目、跨 owner、篡改签名和过期后的重放", () => {
    const now = 1_754_070_000_000;
    const url = new URL(
      createSignedAssetUrl({
        asset: ASSET,
        now,
        ttlSeconds: 900,
      }),
    );
    const expiresAt = Number(url.searchParams.get("exp"));
    const signature = url.searchParams.get("sig") ?? "";

    const validInput = {
      assetId: ASSET.id,
      projectId: ASSET.projectId,
      ownerId: ASSET.ownerId,
      expiresAt,
      signature,
    };

    expect(verifySignedAssetRequest(validInput, now + 899_000)).toBe(true);
    expect(
      verifySignedAssetRequest(
        { ...validInput, projectId: "00000000-0000-4000-8000-000000000003" },
        now,
      ),
    ).toBe(false);
    expect(
      verifySignedAssetRequest(
        { ...validInput, ownerId: "another-owner-000000000000000000000000000" },
        now,
      ),
    ).toBe(false);
    expect(
      verifySignedAssetRequest(
        { ...validInput, signature: `${signature.slice(0, -1)}x` },
        now,
      ),
    ).toBe(false);
    expect(verifySignedAssetRequest(validInput, now + 901_000)).toBe(false);
  });

  it("将请求 TTL 限制在协议允许的范围内", () => {
    const now = 1_754_070_000_000;
    const tooShort = new URL(
      createSignedAssetUrl({
        asset: ASSET,
        now,
        ttlSeconds: 0,
      }),
    );
    const tooLong = new URL(
      createSignedAssetUrl({
        asset: ASSET,
        now,
        ttlSeconds: 86_400,
      }),
    );

    expect(Number(tooShort.searchParams.get("exp"))).toBe(
      Math.floor(now / 1000) + 1,
    );
    expect(Number(tooLong.searchParams.get("exp"))).toBe(
      Math.floor(now / 1000) + 60 * 60,
    );
  });
});
