import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createShowcaseArtifact,
  sha256Hex,
  validateShowcaseArtifactFiles,
  type ShowcaseArtifactManifest,
  normalizeArtifactPath,
  rewriteStaticAssetReferences,
} from "@/infrastructure/showcase/artifact";

describe("Showcase artifact", () => {
  it("拒绝绝对路径、路径穿越和远程 URL", () => {
    expect(() => normalizeArtifactPath("../index.html")).toThrow();
    expect(() => normalizeArtifactPath("/index.html")).toThrow();
    expect(() =>
      normalizeArtifactPath("https://cdn.example.com/app.js"),
    ).toThrow();
    expect(() => normalizeArtifactPath("//cdn.example.com/app.js")).toThrow();
  });

  it("只改写站点自己的根路径引用", () => {
    const result = new TextDecoder().decode(
      rewriteStaticAssetReferences(
        "index.html",
        new TextEncoder().encode(
          '<script src="/assets/app.js"></script><img src="https://example.com/a.png">',
        ),
      ),
    );

    expect(result).toContain('src="./assets/app.js"');
    expect(result).toContain('src="https://example.com/a.png"');
  });

  it("生成入口校验、hash 清单和可解压 ZIP", async () => {
    const artifact = await createShowcaseArtifact([
      {
        path: "assets/app.js",
        content: new TextEncoder().encode("console.log('ok')"),
      },
      {
        path: "index.html",
        content: new TextEncoder().encode(
          '<script src="/assets/app.js"></script>',
        ),
      },
    ]);

    expect(artifact.manifest.entryPath).toBe("index.html");
    expect(artifact.manifest.files).toHaveLength(2);
    expect(artifact.manifest.totalBytes).toBeGreaterThan(0);

    const entries = unzipSync(artifact.archive);
    expect(new TextDecoder().decode(entries["index.html"])).toContain(
      'src="./assets/app.js"',
    );
    expect(entries["webpilot-artifact.json"]).toBeDefined();
  });

  it("缺少 index.html 时拒绝发布", async () => {
    await expect(
      createShowcaseArtifact([
        {
          path: "assets/app.js",
          content: new TextEncoder().encode("console.log('ok')"),
        },
      ]),
    ).rejects.toThrow("缺少入口文件");
  });

  it("发布前重新校验 manifest、文件集合、大小和实际 hash", async () => {
    const content = new TextEncoder().encode("<h1>showcase</h1>");
    const hash = await sha256Hex(content);
    const manifest: ShowcaseArtifactManifest = {
      format: "webpilot-showcase-artifact-v1",
      entryPath: "index.html",
      files: [{ path: "index.html", byteLength: content.byteLength, hash }],
      totalBytes: content.byteLength,
      createdAt: new Date().toISOString(),
    };

    await expect(
      validateShowcaseArtifactFiles({
        manifest,
        files: [{ path: "index.html", content, hash }],
      }),
    ).resolves.toBeUndefined();

    await expect(
      validateShowcaseArtifactFiles({
        manifest,
        files: [
          {
            path: "index.html",
            content: new TextEncoder().encode("<h1>tampered</h1>"),
            hash,
          },
        ],
      }),
    ).rejects.toThrow("内容 hash 校验失败");
  });

  it("拒绝 manifest 与上传文件不一致", async () => {
    const content = new TextEncoder().encode("<h1>showcase</h1>");
    const hash = await sha256Hex(content);
    const manifest: ShowcaseArtifactManifest = {
      format: "webpilot-showcase-artifact-v1",
      entryPath: "index.html",
      files: [
        { path: "index.html", byteLength: content.byteLength, hash },
        { path: "assets/app.js", byteLength: 1, hash: "0".repeat(64) },
      ],
      totalBytes: content.byteLength + 1,
      createdAt: new Date().toISOString(),
    };

    await expect(
      validateShowcaseArtifactFiles({
        manifest,
        files: [{ path: "index.html", content, hash }],
      }),
    ).rejects.toThrow("数量不一致");

    await expect(
      validateShowcaseArtifactFiles({
        manifest: {
          ...manifest,
          files: [{ ...manifest.files[0], path: "../index.html" }],
        },
        files: [{ path: "index.html", content, hash }],
      }),
    ).rejects.toThrow();
  });

  it("拒绝超过 50 MB 的 artifact", async () => {
    const manifest: ShowcaseArtifactManifest = {
      format: "webpilot-showcase-artifact-v1",
      entryPath: "index.html",
      files: [
        {
          path: "index.html",
          byteLength: 50 * 1024 * 1024 + 1,
          hash: "0".repeat(64),
        },
      ],
      totalBytes: 50 * 1024 * 1024 + 1,
      createdAt: new Date().toISOString(),
    };

    await expect(
      validateShowcaseArtifactFiles({
        manifest,
        files: [
          {
            path: "index.html",
            content: new Uint8Array(),
            hash: "0".repeat(64),
          },
        ],
      }),
    ).rejects.toThrow("超过 50 MB");
  });
});
