import { describe, expect, it } from "vitest";

import { WEBPILOT_RSBUILD_TEMPLATE } from "@/infrastructure/webcontainer/project-template";
import { WebContainerRuntimeManager } from "@/infrastructure/webcontainer/runtime-manager";
import { FakeWebContainer } from "@/tests/helpers/fake-webcontainer";

describe("WebContainer 最小闭环 smoke", () => {
  it("固定模板满足项目契约并完成 boot、mount、install、dev server", async () => {
    const runtime = new FakeWebContainer();
    let bootCount = 0;
    const manager = new WebContainerRuntimeManager({
      boot: async () => {
        bootCount += 1;
        return runtime;
      },
      isCrossOriginIsolated: () => true,
      serverReadyTimeoutMs: 1_000,
    });

    const snapshot = await manager.start(WEBPILOT_RSBUILD_TEMPLATE);
    // 集成测试同时守住模板内容与运行编排，避免“Manager 能启动但模板本身已不可执行”。
    const packageFile = WEBPILOT_RSBUILD_TEMPLATE["package.json"];
    const indexFile = WEBPILOT_RSBUILD_TEMPLATE["index.html"];
    const configFile = WEBPILOT_RSBUILD_TEMPLATE["rsbuild.config.ts"];
    const packageContents =
      "file" in packageFile && "contents" in packageFile.file
        ? packageFile.file.contents.toString()
        : "";
    const configContents =
      "file" in configFile && "contents" in configFile.file
        ? configFile.file.contents.toString()
        : "";

    expect(bootCount).toBe(1);
    expect(packageFile).toHaveProperty("file.contents");
    // WASI binding 是 WebContainer 中运行 Rspack 的关键兼容约束，不能被普通升级误删。
    expect(packageContents).toContain("@rspack/binding-wasm32-wasi");
    // Core 与自定义 WASI binding 必须严格同版。仅固定 binding 仍可能被
    // Rsbuild 的传递依赖范围带到更新 core，导致 dev server 就绪后构建失败。
    expect(packageContents).toContain('"@rspack/core": "2.1.5"');
    expect(packageContents).toContain('"@rspack/binding-wasm32-wasi": "2.1.5"');
    expect(packageContents).toContain(
      "RSPACK_BINDING=@rspack/binding-wasm32-wasi rsbuild dev",
    );
    expect(indexFile).toHaveProperty("file.contents");
    expect(WEBPILOT_RSBUILD_TEMPLATE).toHaveProperty("rsbuild.config.ts");
    // Runtime Bridge 注入 index.html；若 Rsbuild 回退到内置模板，脚本文件即使
    // 写入成功也永远不会出现在 iframe 文档中。
    expect(configContents).toContain('template: "./index.html"');
    expect(
      "directory" in WEBPILOT_RSBUILD_TEMPLATE.src
        ? WEBPILOT_RSBUILD_TEMPLATE.src.directory["index.tsx"]
        : undefined,
    ).toHaveProperty("file.contents");
    expect(runtime.mountedTree).toBe(WEBPILOT_RSBUILD_TEMPLATE);
    expect(runtime.calls).toContain("npm install --no-fund --no-audit --force");
    expect(runtime.calls).toContain("npm run dev");
    expect(snapshot).toMatchObject({
      phase: "ready",
      port: 5173,
      previewUrl: runtime.previewUrl,
    });
  });
});
