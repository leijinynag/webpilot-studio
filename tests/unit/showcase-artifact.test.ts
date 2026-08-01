import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  createShowcaseArtifact,
  normalizeArtifactPath,
  rewriteStaticAssetReferences,
} from "@/infrastructure/showcase/artifact";

describe("Showcase artifact", () => {
  it("拒绝绝对路径、路径穿越和远程 URL", () => {
    expect(() => normalizeArtifactPath("../index.html")).toThrow();
    expect(() => normalizeArtifactPath("/index.html")).toThrow();
    expect(() => normalizeArtifactPath("https://cdn.example.com/app.js")).toThrow();
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
});
