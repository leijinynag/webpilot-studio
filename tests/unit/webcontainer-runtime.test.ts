import { describe, expect, it, vi } from "vitest";

import { WebContainerRuntimeManager } from "@/infrastructure/webcontainer/runtime-manager";
import { FakeWebContainer } from "@/tests/helpers/fake-webcontainer";

describe("WebContainerRuntimeManager", () => {
  it("合并并发启动请求，并完整推进到 ready", async () => {
    const runtime = new FakeWebContainer();
    const boot = vi.fn(async () => runtime);
    const manager = new WebContainerRuntimeManager({
      boot,
      isCrossOriginIsolated: () => true,
      serverReadyTimeoutMs: 1_000,
    });
    const phases: string[] = [];

    manager.subscribe(() => {
      // snapshot 会因日志多次更新，这里只记录阶段变化，验证状态机顺序而非通知次数。
      const phase = manager.getSnapshot().phase;
      if (phases.at(-1) !== phase) {
        phases.push(phase);
      }
    });

    // 模拟 Strict Mode 或多个消费者在同一时刻请求启动。
    const [first, second] = await Promise.all([
      manager.start(),
      manager.start(),
    ]);

    expect(boot).toHaveBeenCalledTimes(1);
    expect(first.phase).toBe("ready");
    expect(second.previewUrl).toBe(runtime.previewUrl);
    expect(runtime.calls).toEqual([
      "mount",
      "npm install --no-fund --no-audit --force",
      "listen:server-ready",
      "npm run dev",
    ]);
    expect(phases).toEqual([
      "booting",
      "mounting",
      "installing",
      "starting",
      "ready",
    ]);
  });

  it("缺少 Cross-Origin Isolation 时在 boot 前失败", async () => {
    const boot = vi.fn(async () => new FakeWebContainer());
    const manager = new WebContainerRuntimeManager({
      boot,
      isCrossOriginIsolated: () => false,
    });

    // 隔离能力是硬前置条件，失败时不应创建任何昂贵的 SDK/worker 资源。
    await expect(manager.start()).rejects.toMatchObject({
      diagnostic: {
        code: "cross_origin_isolation_required",
      },
    });
    expect(boot).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({
      phase: "failed",
      crossOriginIsolated: false,
    });
  });

  it("依赖安装失败时保留终端输出与明确诊断", async () => {
    const runtime = new FakeWebContainer();
    runtime.installExitCode = 1;
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
    });

    await expect(manager.start()).rejects.toMatchObject({
      diagnostic: {
        code: "install_failed",
      },
    });

    const snapshot = manager.getSnapshot();
    expect(snapshot.phase).toBe("failed");
    // 安装输出需要保留，但 npm 的单字符 spinner 应在进入 UI 前被过滤。
    expect(snapshot.logs.join("\n")).toContain("dependencies installed");
    expect(snapshot.logs).not.toContain("[install] |");
    expect(snapshot.diagnostic?.message).toContain("退出码 1");
  });
});
