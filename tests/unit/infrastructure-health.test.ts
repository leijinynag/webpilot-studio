// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { verifyPrivateBlobReadWrite } from "@/infrastructure/blob/health";
import { verifyDatabaseReadAccess } from "@/infrastructure/db/health";

describe("infrastructure health checks", () => {
  it("accepts the fixed read-only database probe", async () => {
    const query = vi.fn().mockResolvedValue([{ health: 1 }]);

    await expect(verifyDatabaseReadAccess(query)).resolves.toEqual({
      provider: "neon",
      status: "ok",
      readOnly: true,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects an unexpected database response", async () => {
    await expect(
      verifyDatabaseReadAccess(async () => [{ health: 0 }]),
    ).rejects.toThrow("非预期结果");
  });

  it("uploads a private probe and always removes it", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const upload = vi.fn().mockResolvedValue({
      pathname: "health-checks/fixed-id.txt",
      url: "https://blob.example/health-checks/fixed-id.txt",
    });

    await expect(
      verifyPrivateBlobReadWrite({
        upload,
        remove,
        createId: () => "fixed-id",
      }),
    ).resolves.toEqual({
      provider: "vercel-blob",
      status: "ok",
      access: "private",
    });

    expect(upload).toHaveBeenCalledWith(
      "health-checks/fixed-id.txt",
      "webpilot-studio blob health check",
    );
    expect(remove).toHaveBeenCalledWith(
      "https://blob.example/health-checks/fixed-id.txt",
    );
  });

  it("cleans up an uploaded probe even when validation fails", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(
      verifyPrivateBlobReadWrite({
        upload: async () => ({
          pathname: "unexpected.txt",
          url: "https://blob.example/unexpected.txt",
        }),
        remove,
        createId: () => "fixed-id",
      }),
    ).rejects.toThrow("非预期对象");

    expect(remove).toHaveBeenCalledWith("https://blob.example/unexpected.txt");
  });
});
