import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/health/route";

describe("health route", () => {
  beforeEach(() => {
    vi.stubEnv("SHOWCASE_RUNTIME_ONLY", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "local-test-sha");
  });

  it("returns a non-sensitive primary deployment marker", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "webpilot-studio",
      deployment: "primary",
      runtimeOnly: false,
      build: "local-test-sha",
    });
  });

  it("identifies the isolated Showcase Runtime deployment", async () => {
    vi.stubEnv("SHOWCASE_RUNTIME_ONLY", "true");

    const response = GET();

    await expect(response.json()).resolves.toMatchObject({
      deployment: "showcase-runtime",
      runtimeOnly: true,
    });
  });
});
