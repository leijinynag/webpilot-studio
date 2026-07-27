import { describe, expect, it } from "vitest";

import { checkPrivateBlobStorage } from "@/infrastructure/blob/health";
import { checkNeonDatabase } from "@/infrastructure/db/health";

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`运行基础设施验收前必须配置 ${name}。`);
  }

  return value;
}

describe("live infrastructure", () => {
  it("executes a read-only query against Neon Postgres", async () => {
    const result = await checkNeonDatabase(
      requireEnvironmentVariable("DATABASE_URL"),
    );

    expect(result).toEqual({
      provider: "neon",
      status: "ok",
      readOnly: true,
    });
  });

  it("uploads and removes a private Vercel Blob object", async () => {
    const result = await checkPrivateBlobStorage(
      requireEnvironmentVariable("BLOB_READ_WRITE_TOKEN"),
    );

    expect(result).toEqual({
      provider: "vercel-blob",
      status: "ok",
      access: "private",
    });
  });
});
