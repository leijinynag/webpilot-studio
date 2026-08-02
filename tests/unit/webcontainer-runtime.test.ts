import { describe, expect, it, vi } from "vitest";

import { WebContainerRuntimeManager } from "@/infrastructure/webcontainer/runtime-manager";
import {
  FakeWebContainer,
  FakeWebContainerProcess,
} from "@/tests/helpers/fake-webcontainer";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

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
    expect(first.syncedRevision).toBeNull();
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

  it("把普通源码 revision 增量同步到已运行的容器", async () => {
    const runtime = new FakeWebContainer();
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
    });
    const firstTree = {
      src: {
        directory: {
          "index.tsx": { file: { contents: "revision-1" } },
          "old.ts": { file: { contents: "remove-me" } },
        },
      },
    };
    const secondTree = {
      src: {
        directory: {
          "index.tsx": { file: { contents: "revision-2" } },
          "new.ts": { file: { contents: "new-file" } },
        },
      },
    };

    await manager.start(firstTree, "project-a", 1);
    await manager.syncRevision(secondTree, "project-a", 2);

    expect(runtime.calls).toContain("rm:src/old.ts");
    expect(runtime.calls).toContain("write:src/index.tsx:revision-2");
    expect(runtime.calls).toContain("write:src/new.ts:new-file");
    expect(manager.getSnapshot().syncedRevision).toBe(2);
  });

  it("把 forwardPreviewErrors 输出记录为 revision 绑定的浏览器异常", async () => {
    const runtime = new FakeWebContainer();
    const originalSpawn = runtime.spawn.bind(runtime);
    let emitDevOutput: (line: string) => void = () => {
      throw new Error("dev output stream 尚未初始化。");
    };
    runtime.spawn = async (command, args) => {
      const process = await originalSpawn(command, args);
      if (args[0] !== "run") {
        return process;
      }

      const controlledProcess = new FakeWebContainerProcess(0);
      Object.defineProperty(controlledProcess, "exit", {
        value: runtime.devExit,
      });
      Object.defineProperty(controlledProcess, "output", {
        value: new ReadableStream<string>({
          start(controller) {
            emitDevOutput = (line) => controller.enqueue(line);
          },
        }),
      });
      return controlledProcess;
    };
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
    });

    await manager.start({}, "project-a", 7);
    emitDevOutput("error [browser] Uncaught TypeError: button failed\n");

    await vi.waitFor(() => {
      expect(manager.getSnapshot().forwardedPreviewErrors).toEqual([
        expect.objectContaining({
          revision: 7,
          message: "Uncaught TypeError: button failed",
        }),
      ]);
    });
  });

  it("显式执行 production build 并读取 dist 生成 Showcase artifact", async () => {
    const runtime = new FakeWebContainer();
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
      productionBuildTimeoutMs: 1_000,
    });

    const result = await manager.buildProduction(
      { "package.json": { file: { contents: "{}" } } },
      "project-a",
      4,
    );

    expect(result.manifest.entryPath).toBe("index.html");
    expect(result.manifest.files).toHaveLength(2);
    expect(runtime.calls).toContain("npm run build");
    expect(runtime.calls).toContain("readdir:dist");
    expect(runtime.calls).toContain("readdir:dist/static");
    expect(runtime.calls).toContain("read:dist/index.html");
    expect(runtime.calls).toContain("read:dist/static/app.js");
    expect(runtime.calls).not.toContain("read:dist/static/index.html");
  });

  it("相同 revision 的不同运行镜像 key 仍会触发同步", async () => {
    const runtime = new FakeWebContainer();
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
    });
    const repositoryTree = {
      "index.html": { file: { contents: "<div>repository</div>" } },
    };
    const instrumentedTree = {
      "index.html": { file: { contents: "<div>runtime bridge</div>" } },
    };

    await manager.start(repositoryTree, "project-a", 2, "repository:2");
    await manager.start(instrumentedTree, "project-a", 2, "agent:call-1:2");

    expect(runtime.calls).toContain(
      "write:index.html:<div>runtime bridge</div>",
    );
    expect(manager.getSnapshot().syncedRevision).toBe(2);
  });

  it("串行执行同项目的并发同步，避免运行镜像交错覆盖", async () => {
    const runtime = new FakeWebContainer();
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
    });
    const repositoryWriteStarted = createDeferred<void>();
    const releaseRepositoryWrite = createDeferred<void>();
    const originalWriteFile = runtime.fs.writeFile;
    runtime.fs.writeFile = async (path, content) => {
      if (path === "index.html" && content.toString() === "repository") {
        repositoryWriteStarted.resolve();
        await releaseRepositoryWrite.promise;
      }
      await originalWriteFile(path, content);
    };

    await manager.start(
      { "index.html": { file: { contents: "base" } } },
      "project-a",
      1,
    );
    const repositorySync = manager.syncRevision(
      { "index.html": { file: { contents: "repository" } } },
      "project-a",
      2,
      "repository:2",
    );
    await repositoryWriteStarted.promise;
    const agentSync = manager.syncRevision(
      { "index.html": { file: { contents: "runtime bridge" } } },
      "project-a",
      2,
      "agent:call-1:2",
    );

    // 第一轮写入仍被阻塞时，第二轮不能提前触碰文件系统。
    expect(runtime.calls).not.toContain("write:index.html:runtime bridge");
    releaseRepositoryWrite.resolve();
    await Promise.all([repositorySync, agentSync]);

    const repositoryWriteIndex = runtime.calls.indexOf(
      "write:index.html:repository",
    );
    const agentWriteIndex = runtime.calls.indexOf(
      "write:index.html:runtime bridge",
    );
    expect(repositoryWriteIndex).toBeGreaterThan(-1);
    expect(agentWriteIndex).toBeGreaterThan(repositoryWriteIndex);
  });

  it("依赖清单变化时重建容器而不是假设 HMR 可处理", async () => {
    const firstRuntime = new FakeWebContainer();
    const secondRuntime = new FakeWebContainer();
    const boot = vi
      .fn<() => Promise<FakeWebContainer>>()
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(secondRuntime);
    const manager = new WebContainerRuntimeManager({
      boot,
      isCrossOriginIsolated: () => true,
    });

    await manager.start(
      { "package.json": { file: { contents: '{"version":1}' } } },
      "project-a",
      1,
    );
    await manager.syncRevision(
      { "package.json": { file: { contents: '{"version":2}' } } },
      "project-a",
      2,
    );

    expect(firstRuntime.calls).toContain("teardown");
    expect(secondRuntime.calls).toContain("mount");
    expect(boot).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot().syncedRevision).toBe(2);
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

  it("安装输出流未关闭时仍以 exit code 推进生命周期", async () => {
    const runtime = new FakeWebContainer();
    const originalSpawn = runtime.spawn.bind(runtime);
    runtime.spawn = async (command, args) => {
      const process = await originalSpawn(command, args);

      if (args[0] === "install") {
        Object.defineProperty(process, "output", {
          value: new ReadableStream<string>({
            start(controller) {
              controller.enqueue("install still streaming\n");
            },
          }),
        });
      }

      return process;
    };
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
      installTimeoutMs: 1_000,
    });

    await expect(manager.start()).resolves.toMatchObject({ phase: "ready" });
  });

  it("安装超时后终止旧进程，并允许下一次启动使用干净进程重试", async () => {
    const runtime = new FakeWebContainer();
    const blockedInstall = new FakeWebContainerProcess(0);
    Object.defineProperty(blockedInstall, "exit", {
      value: new Promise<number>(() => undefined),
    });
    const retryInstall = new FakeWebContainerProcess(0, [
      "retry dependencies installed",
    ]);
    const originalSpawn = runtime.spawn.bind(runtime);
    let installAttempt = 0;

    runtime.spawn = async (command, args) => {
      if (args[0] === "install") {
        installAttempt += 1;
        runtime.calls.push(`${command} ${args.join(" ")}`);
        return installAttempt === 1 ? blockedInstall : retryInstall;
      }
      return originalSpawn(command, args);
    };

    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
      installTimeoutMs: 20,
      serverReadyTimeoutMs: 1_000,
    });

    await expect(manager.start()).rejects.toMatchObject({
      diagnostic: {
        code: "install_failed",
        message: "依赖安装超时，运行镜像未能完成准备。",
      },
    });
    expect(blockedInstall.killed).toBe(true);

    await expect(manager.start()).resolves.toMatchObject({ phase: "ready" });
    expect(installAttempt).toBe(2);
    expect(retryInstall.killed).toBe(false);
  });

  it("teardown 会终止仍在运行的依赖安装进程", async () => {
    const runtime = new FakeWebContainer();
    const blockedInstall = new FakeWebContainerProcess(0);
    Object.defineProperty(blockedInstall, "exit", {
      value: new Promise<number>(() => undefined),
    });
    const installSpawned = createDeferred<void>();
    const originalSpawn = runtime.spawn.bind(runtime);

    runtime.spawn = async (command, args) => {
      if (args[0] === "install") {
        runtime.calls.push(`${command} ${args.join(" ")}`);
        installSpawned.resolve();
        return blockedInstall;
      }
      return originalSpawn(command, args);
    };

    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
      installTimeoutMs: 10_000,
    });
    const start = manager.start();
    // 先为 rejection 注册观察者，避免 teardown 后的取消异常在断言接管前
    // 被 Vitest 记录成 unhandled rejection。
    const startRejected = expect(start).rejects.toBeInstanceOf(Error);
    await installSpawned.promise;

    manager.teardown();

    expect(manager.getSnapshot().phase).toBe("idle");
    // spawn Promise 可能已返回进程，但 await continuation 尚未恢复。Manager 会在
    // generation 检查点终止这份迟到资源，因此先等待启动链结束再验证 kill。
    await startRejected;
    expect(blockedInstall.killed).toBe(true);
  });

  it("teardown 后观察并忽略 dev 进程的预期中止 rejection", async () => {
    const runtime = new FakeWebContainer();
    const devExit = createDeferred<number>();
    runtime.devExit = devExit.promise;
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
      serverReadyTimeoutMs: 1_000,
    });

    await manager.start();
    manager.teardown();
    devExit.reject(new Error("Process aborted"));

    // 等待 exit rejection handler 执行。若 Manager 没有注册 rejection 分支，
    // Vitest 会把这次预期 teardown 记录为 unhandled rejection 并使测试失败。
    await Promise.resolve();
    expect(manager.getSnapshot().phase).toBe("idle");
  });

  it("当前 generation 的 dev 进程异常 rejection 会转成结构化失败", async () => {
    const runtime = new FakeWebContainer();
    const devExit = createDeferred<number>();
    runtime.devExit = devExit.promise;
    const manager = new WebContainerRuntimeManager({
      boot: async () => runtime,
      isCrossOriginIsolated: () => true,
      serverReadyTimeoutMs: 1_000,
    });

    await manager.start();
    devExit.reject(new Error("worker crashed"));

    await vi.waitFor(() => {
      expect(manager.getSnapshot()).toMatchObject({
        phase: "failed",
        diagnostic: {
          code: "dev_server_failed",
          message: "开发服务器进程异常中止。",
          detail: "worker crashed",
        },
      });
    });
  });

  it("项目切换后忽略旧项目迟到的 boot 和 finally", async () => {
    const firstRuntime = new FakeWebContainer();
    const secondRuntime = new FakeWebContainer();
    secondRuntime.previewUrl = "https://5173-second-project.local";
    const firstBoot = createDeferred<FakeWebContainer>();
    const boot = vi
      .fn<() => Promise<FakeWebContainer>>()
      .mockImplementationOnce(() => firstBoot.promise)
      .mockResolvedValueOnce(secondRuntime);
    const manager = new WebContainerRuntimeManager({
      boot,
      isCrossOriginIsolated: () => true,
      serverReadyTimeoutMs: 1_000,
    });

    const firstStart = manager.start({}, "project-a");
    // 等待第一轮进入 boot，随后在其完成前切换项目。
    await Promise.resolve();
    const secondStart = manager.start({}, "project-b");
    await expect(secondStart).resolves.toMatchObject({
      phase: "ready",
      previewUrl: secondRuntime.previewUrl,
    });

    firstBoot.resolve(firstRuntime);
    await expect(firstStart).rejects.toBeInstanceOf(Error);

    expect(firstRuntime.calls).toContain("teardown");
    expect(secondRuntime.calls).not.toContain("teardown");
    expect(manager.getSnapshot()).toMatchObject({
      phase: "ready",
      previewUrl: secondRuntime.previewUrl,
    });
    // 旧 Promise 的 finally 没有清理新项目锁，重复调用不会再次 boot。
    await manager.start({}, "project-b");
    expect(boot).toHaveBeenCalledTimes(2);
  });
});
