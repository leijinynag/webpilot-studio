import type { FileSystemTree, WebContainerProcess } from "@webcontainer/api";

import {
  getErrorDetail,
  WebContainerRuntimeError,
} from "@/infrastructure/webcontainer/errors";
import {
  createInitialRuntimeSnapshot,
  type WebContainerErrorCode,
  type WebContainerPhase,
  type WebContainerRuntimeSnapshot,
} from "@/infrastructure/webcontainer/lifecycle";
import {
  WEBPILOT_PREVIEW_PORT,
  WEBPILOT_RSBUILD_TEMPLATE,
} from "@/infrastructure/webcontainer/project-template";

type RuntimeListener = () => void;
type ServerReadyListener = (port: number, url: string) => void;

// Manager 只依赖运行所需的最小接口，而不是把 SDK 实例直接暴露给业务层。
// 这样单元测试可以注入轻量 Fake，也便于未来替换进程输出或容器实现。
export type WebContainerProcessAdapter = Pick<
  WebContainerProcess,
  "exit" | "kill" | "output"
>;

export type WebContainerAdapter = {
  mount(tree: FileSystemTree): Promise<void>;
  spawn(command: string, args: string[]): Promise<WebContainerProcessAdapter>;
  on(event: "server-ready", listener: ServerReadyListener): () => void;
  fs: {
    mkdir(path: string, options: { recursive: true }): Promise<string>;
    rename(oldPath: string, newPath: string): Promise<void>;
    rm(
      path: string,
      options?: { force?: boolean; recursive?: boolean },
    ): Promise<void>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
  };
  teardown(): void;
};

// 浏览器能力检测与 boot 行为都通过依赖注入进入 Manager。
// 生产环境使用真实实现，测试环境则可以稳定覆盖隔离失败、安装失败和超时等分支。
export type WebContainerRuntimeDependencies = {
  boot: () => Promise<WebContainerAdapter>;
  isCrossOriginIsolated: () => boolean;
  installTimeoutMs?: number;
  serverReadyTimeoutMs?: number;
};

// 日志属于高频状态，必须设置上限，避免长时间运行后 snapshot 无限增长并拖慢 React 更新。
const MAX_LOG_LINES = 160;
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const NPM_SPINNER_LINE_PATTERN = /^[|/\\-]$/;
const FORWARDED_BROWSER_ERROR_PATTERN = /^\s*error\s+\[browser\]\s+(.+)$/i;
const RUNTIME_RESTART_PATHS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "rsbuild.config.ts",
  "rsbuild.config.js",
]);

async function bootWebContainer(): Promise<WebContainerAdapter> {
  // 动态加载确保 Next.js 服务端构建阶段不会执行依赖浏览器环境的 WebContainer 代码。
  const { WebContainer } = await import("@webcontainer/api");

  return WebContainer.boot({
    // 与 next.config.ts 返回的 COEP 响应头保持一致，SharedArrayBuffer 才能在页面中使用。
    coep: "require-corp",
    // 将预览页中的编译和运行异常转交宿主页面，后续可统一接入 Diagnostics。
    forwardPreviewErrors: true,
    workdirName: "webpilot-preview",
  });
}

function isBrowserCrossOriginIsolated(): boolean {
  // 服务端渲染阶段没有 window，此时不能把“尚未进入浏览器”误判为可启动状态。
  return typeof window !== "undefined" && window.crossOriginIsolated === true;
}

// 非结构化异常往往只携带原始 message。根据失败时所处阶段映射为稳定错误码，
// UI、埋点和测试因此不需要解析第三方 SDK 或 npm 的具体报错文本。
function phaseToFailure(phase: WebContainerPhase): {
  code: WebContainerErrorCode;
  message: string;
} {
  switch (phase) {
    case "booting":
      return {
        code: "boot_failed",
        message: "WebContainer 启动失败，请确认浏览器支持并重试。",
      };
    case "mounting":
      return {
        code: "mount_failed",
        message: "项目文件挂载失败，运行镜像尚未准备完成。",
      };
    case "installing":
      return {
        code: "install_failed",
        message: "依赖安装失败，请检查终端日志和网络连接。",
      };
    default:
      return {
        code: "dev_server_failed",
        message: "开发服务器启动失败，请检查终端日志。",
      };
  }
}

/**
 * 一个标签页只持有一个 Manager 实例。React Strict Mode 或多个组件同时调用
 * start() 时，会共享同一条启动 Promise，不会重复执行 WebContainer.boot()。
 */
export class WebContainerRuntimeManager {
  private readonly dependencies: Required<WebContainerRuntimeDependencies>;
  private readonly listeners = new Set<RuntimeListener>();
  // snapshot 是唯一的 UI 可观察状态，每次更新都替换对象引用以满足 external store 契约。
  private snapshot = createInitialRuntimeSnapshot();
  // instance 缓存已成功 boot 的昂贵运行时；bootPromise 合并尚未完成的 boot 请求；
  // startPromise 再向上合并 mount、install、dev server 这一整条启动链。
  private instance: WebContainerAdapter | null = null;
  private bootPromise: Promise<WebContainerAdapter> | null = null;
  private startPromise: Promise<WebContainerRuntimeSnapshot> | null = null;
  // 普通 Repository 刷新与 Agent 运行镜像可能在同一 revision 上同时到达。
  // 文件系统写入必须串行，否则两次 diff 会基于同一旧快照计算并交错覆盖 index.html。
  private syncTail: Promise<void> = Promise.resolve();
  private devProcess: WebContainerProcessAdapter | null = null;
  // ready 状态只对当前项目有效；切换项目必须销毁旧容器，避免 mount 合并出跨项目残留文件。
  private activeProjectKey: string | null = null;
  // Repository revision 与运行镜像身份并不总是一一对应。run_preview 会在相同
  // revision 上临时注入 Bridge，因此需要独立 key 触发同步，不能把它误判为旧镜像。
  private activeRuntimeKey: string | null = null;
  // mountedFiles 记录运行镜像当前内容，增量同步时据此识别新增、修改和删除。
  private mountedFiles = new Map<string, string>();
  // generation 是轻量取消令牌。teardown 或未来的新一轮启动会递增它，
  // 旧异步任务即使晚到，也不能再把过期结果写回当前 snapshot。
  private generation = 0;

  constructor(dependencies?: Partial<WebContainerRuntimeDependencies>) {
    this.dependencies = {
      boot: dependencies?.boot ?? bootWebContainer,
      isCrossOriginIsolated:
        dependencies?.isCrossOriginIsolated ?? isBrowserCrossOriginIsolated,
      installTimeoutMs: dependencies?.installTimeoutMs ?? 180_000,
      serverReadyTimeoutMs: dependencies?.serverReadyTimeoutMs ?? 120_000,
    };
  }

  // 使用箭头属性保持 this 稳定，React 可直接把这两个函数交给 useSyncExternalStore。
  readonly getSnapshot = (): WebContainerRuntimeSnapshot => this.snapshot;

  readonly subscribe = (listener: RuntimeListener): (() => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  start(
    tree: FileSystemTree = WEBPILOT_RSBUILD_TEMPLATE,
    projectKey = "default-template",
    revision: number | null = null,
    runtimeKey = `revision:${revision ?? "unknown"}`,
  ): Promise<WebContainerRuntimeSnapshot> {
    if (
      this.activeProjectKey !== null &&
      this.activeProjectKey !== projectKey
    ) {
      this.teardown();
    }

    // ready 状态代表当前 dev server 仍由 Manager 持有，无需重复挂载和安装依赖。
    if (
      this.snapshot.phase === "ready" &&
      this.activeProjectKey === projectKey
    ) {
      return this.activeRuntimeKey === runtimeKey
        ? Promise.resolve(this.snapshot)
        : this.syncRevision(tree, projectKey, revision, runtimeKey);
    }

    // Strict Mode、多个预览消费者或用户连续点击重试都可能同时调用 start。
    // 若后来的请求携带不同 runtimeKey，则在当前启动完成后补一次增量同步。
    // 这覆盖“普通 Preview 正在安装时 Agent 请求注入 Bridge”的真实竞态。
    if (this.startPromise) {
      return this.startPromise.then(() => {
        if (this.activeProjectKey !== projectKey) {
          return this.start(tree, projectKey, revision, runtimeKey);
        }

        return this.activeRuntimeKey === runtimeKey
          ? this.snapshot
          : this.syncRevision(tree, projectKey, revision, runtimeKey);
      });
    }

    this.activeProjectKey = projectKey;
    const currentStart = this.startRuntime(tree, revision, runtimeKey).finally(
      () => {
        // 旧项目的 finally 可能晚于新项目启动；只允许当前 Promise 清理自己的锁。
        if (this.startPromise === currentStart) {
          this.startPromise = null;
        }
      },
    );
    this.startPromise = currentStart;

    return currentStart;
  }

  /**
   * 将一个已成功保存的 Repository revision 写入当前运行镜像。
   * 普通源码文件使用 fs 增量同步，依赖与构建配置变化则重新启动容器，
   * 因为仅靠 HMR 无法保证安装结果、Node 进程参数或插件图已经更新。
   */
  syncRevision(
    tree: FileSystemTree,
    projectKey: string,
    revision: number | null,
    runtimeKey = `revision:${revision ?? "unknown"}`,
  ): Promise<WebContainerRuntimeSnapshot> {
    if (this.activeProjectKey !== projectKey) {
      return this.start(tree, projectKey, revision, runtimeKey);
    }

    const queuedSync = this.syncTail.then(
      () => this.performSyncRevision(tree, projectKey, revision, runtimeKey),
      () => this.performSyncRevision(tree, projectKey, revision, runtimeKey),
    );
    // 单次同步失败仍应原样返回给调用方，但不能让队列永久停在 rejected。
    this.syncTail = queuedSync.then(
      () => undefined,
      () => undefined,
    );

    return queuedSync;
  }

  private async performSyncRevision(
    tree: FileSystemTree,
    projectKey: string,
    revision: number | null,
    runtimeKey: string,
  ): Promise<WebContainerRuntimeSnapshot> {
    if (this.startPromise) {
      await this.startPromise;
    }

    // 排队期间用户可能已经切换项目。旧同步只能自然结束，不能重新启动旧项目
    // 并覆盖当前工作台持有的 WebContainer。
    if (this.activeProjectKey !== projectKey) {
      return this.snapshot;
    }

    if (!this.instance || this.snapshot.phase !== "ready") {
      return this.start(tree, projectKey, revision, runtimeKey);
    }

    if (this.activeRuntimeKey === runtimeKey) {
      return this.snapshot;
    }

    const nextFiles = flattenRuntimeTree(tree);
    const changedPaths = new Set<string>();

    for (const [path, content] of nextFiles) {
      if (this.mountedFiles.get(path) !== content) {
        changedPaths.add(path);
      }
    }

    for (const path of this.mountedFiles.keys()) {
      if (!nextFiles.has(path)) {
        changedPaths.add(path);
      }
    }

    if ([...changedPaths].some((path) => RUNTIME_RESTART_PATHS.has(path))) {
      this.appendLog("[runtime] 依赖或构建配置已变化，正在重建运行镜像...");
      this.teardown();
      return this.start(tree, projectKey, revision);
    }

    try {
      for (const path of this.mountedFiles.keys()) {
        if (!nextFiles.has(path)) {
          await this.instance.fs.rm(path, { force: true });
          this.appendLog(`[sync] 删除 ${path}`);
        }
      }

      for (const [path, content] of nextFiles) {
        if (this.mountedFiles.get(path) === content) {
          continue;
        }

        const parent = path.split("/").slice(0, -1).join("/");
        if (parent) {
          await this.instance.fs.mkdir(parent, { recursive: true });
        }
        await this.instance.fs.writeFile(path, content);
        this.appendLog(`[sync] 写入 ${path}`);
      }

      this.mountedFiles = nextFiles;
      this.activeRuntimeKey = runtimeKey;
      this.setSnapshot({
        ...this.snapshot,
        syncedRevision: revision,
        diagnostic: null,
      });
      this.appendLog(
        `[runtime] 运行镜像已同步至 revision ${revision ?? "unknown"}。`,
      );
      return this.snapshot;
    } catch (error) {
      const runtimeError = new WebContainerRuntimeError(
        "mount_failed",
        "已保存代码未能同步到浏览器运行镜像。",
        {
          cause: error,
          detail: getErrorDetail(error),
        },
      );
      this.fail(runtimeError);
      throw runtimeError;
    }
  }

  /**
   * teardown 只供显式释放资源或测试使用。普通组件卸载不调用它，避免路由切换时
   * 销毁昂贵的浏览器运行时，并保证 Preview 与后续 Export 可以共享实例。
   */
  teardown(): void {
    this.generation += 1;
    this.devProcess?.kill();
    this.devProcess = null;
    this.instance?.teardown();
    this.instance = null;
    this.bootPromise = null;
    this.startPromise = null;
    this.activeProjectKey = null;
    this.activeRuntimeKey = null;
    this.mountedFiles = new Map();
    this.setSnapshot(createInitialRuntimeSnapshot());
  }

  private async startRuntime(
    tree: FileSystemTree,
    revision: number | null,
    runtimeKey: string,
  ): Promise<WebContainerRuntimeSnapshot> {
    const generation = ++this.generation;
    const crossOriginIsolated = this.dependencies.isCrossOriginIsolated();

    // WebContainer 依赖 SharedArrayBuffer。先做同步前置检查，可以在下载 SDK、
    // 创建 worker 之前给出明确诊断，也避免留下半初始化的容器资源。
    if (!crossOriginIsolated) {
      const error = new WebContainerRuntimeError(
        "cross_origin_isolation_required",
        "当前页面未启用 Cross-Origin Isolation，WebContainer 已停止启动。",
        {
          detail:
            "请确认响应包含 COOP: same-origin 与 COEP: require-corp，然后完整刷新页面。",
        },
      );

      this.setSnapshot({
        ...createInitialRuntimeSnapshot(),
        phase: "failed",
        crossOriginIsolated: false,
        diagnostic: error.diagnostic,
      });
      throw error;
    }

    // 重试时保留已 boot 的容器，但旧 dev process 必须停止，避免端口冲突和重复输出。
    this.devProcess?.kill();
    this.devProcess = null;
    this.setSnapshot({
      ...createInitialRuntimeSnapshot(),
      phase: "booting",
      crossOriginIsolated: true,
      logs: ["[runtime] Cross-Origin Isolation 已启用。"],
    });

    try {
      const instance = await this.getOrBootInstance(generation);
      this.assertGeneration(generation);

      // mount、install、start 存在严格数据依赖：后一阶段只能在前一阶段成功后开始。
      // 保持串行也让 snapshot.phase 能准确指向实际失败位置。
      this.setPhase("mounting");
      this.appendLog("[runtime] 正在挂载固定 Rsbuild 项目模板...");
      await instance.mount(tree);
      this.mountedFiles = flattenRuntimeTree(tree);
      this.activeRuntimeKey = runtimeKey;
      this.assertGeneration(generation);

      this.setPhase("installing");
      // Rspack 的 WASI 包声明 cpu=wasm32，而 WebContainer 的 Node 兼容层报告
      // cpu=x64。这里仅对运行镜像放宽 npm 平台校验，主应用安装策略不受影响。
      this.appendLog("[install] npm install --no-fund --no-audit --force");
      const installProcess = await instance.spawn("npm", [
        "install",
        "--no-fund",
        "--no-audit",
        "--force",
      ]);
      // stdout 在部分 WebContainer/npm 组合里会比进程退出更晚关闭。
      // 输出持续后台消费，安装阶段的完成事实以 exit code 为准，避免界面永久卡在 installing。
      const installOutput = this.consumeProcessOutput(
        installProcess,
        "install",
        generation,
      );
      const installExitCode = await withTimeout(
        installProcess.exit,
        this.dependencies.installTimeoutMs,
        () =>
          new WebContainerRuntimeError(
            "install_failed",
            "依赖安装超时，运行镜像未能完成准备。",
            {
              detail: `npm install 在 ${this.dependencies.installTimeoutMs}ms 内未退出。`,
            },
          ),
      );
      // 给已结束进程的剩余输出一个很短的排空窗口；超时后继续启动，
      // 后台消费者仍会在流真正关闭时自行结束。
      await Promise.race([installOutput, delayMilliseconds(500)]);

      if (installExitCode !== 0) {
        throw new WebContainerRuntimeError(
          "install_failed",
          `依赖安装进程异常退出，退出码 ${installExitCode}。`,
        );
      }

      this.assertGeneration(generation);
      this.setPhase("starting");
      this.appendLog(
        `[dev] npm run dev，等待固定端口 ${WEBPILOT_PREVIEW_PORT}...`,
      );
      const server = await this.startDevServer(instance, generation);

      // 只有收到目标端口的 server-ready 后才发布 URL，避免 iframe 访问尚未可用的服务。
      this.setSnapshot({
        ...this.snapshot,
        phase: "ready",
        previewUrl: server.url,
        port: server.port,
        diagnostic: null,
        syncedRevision: revision,
      });
      this.appendLog(`[runtime] 预览服务已就绪：${server.url}`);

      return this.snapshot;
    } catch (error) {
      // 项目切换会递增 generation。过期链路只需结束，不能把新项目状态覆盖成 failed。
      if (generation !== this.generation) {
        throw error;
      }

      // 主动创建的运行时错误已经携带稳定诊断，不能再被阶段映射覆盖。
      if (error instanceof WebContainerRuntimeError) {
        this.fail(error);
        throw error;
      }

      // SDK、流或浏览器抛出的未知异常在这里按当前阶段归一化，同时保留原始 cause。
      const failure = phaseToFailure(this.snapshot.phase);
      const runtimeError = new WebContainerRuntimeError(
        failure.code,
        failure.message,
        {
          cause: error,
          detail: getErrorDetail(error),
        },
      );
      this.fail(runtimeError);
      throw runtimeError;
    }
  }

  private async getOrBootInstance(
    generation: number,
  ): Promise<WebContainerAdapter> {
    if (this.instance) {
      this.appendLog("[runtime] 复用当前标签页中的 WebContainer 实例。");
      return this.instance;
    }

    // boot 本身也单独去重，避免未来出现“不启动项目、只预热容器”的调用后重复 boot。
    if (!this.bootPromise) {
      this.appendLog("[runtime] 正在 boot WebContainer...");
      const currentBoot = this.dependencies
        .boot()
        .then((instance) => {
          if (generation !== this.generation) {
            instance.teardown();
            throw new WebContainerRuntimeError(
              "dev_server_failed",
              "本次 WebContainer boot 已被新的项目替代。",
            );
          }

          this.instance = instance;
          return instance;
        })
        .catch((error: unknown) => {
          // boot 失败后清除缓存，允许用户修复环境后重新发起真正的新启动。
          if (this.bootPromise === currentBoot) {
            this.bootPromise = null;
          }
          throw error;
        });
      this.bootPromise = currentBoot;
    }

    return this.bootPromise;
  }

  private async startDevServer(
    instance: WebContainerAdapter,
    generation: number,
  ): Promise<{ port: number; url: string }> {
    // server-ready、超时、进程提前退出会竞争同一个 Promise。
    // serverSettled 保证三条路径中只有第一条能够完成或拒绝启动结果。
    let rejectReady: (reason: unknown) => void = () => undefined;
    let serverSettled = false;
    let unsubscribe: () => void = () => undefined;
    let timeout: number | undefined;

    const serverReady = new Promise<{ port: number; url: string }>(
      (resolve, reject) => {
        rejectReady = reject;
        // 先订阅再 spawn，避免极快的 dev server 在监听器注册前发出就绪事件。
        unsubscribe = instance.on("server-ready", (port, url) => {
          // WebContainer 可能转发其他端口，旧 generation 也可能晚到；两者都不能成为当前预览。
          if (
            port !== WEBPILOT_PREVIEW_PORT ||
            generation !== this.generation
          ) {
            return;
          }

          serverSettled = true;
          unsubscribe();
          if (timeout !== undefined) {
            window.clearTimeout(timeout);
          }
          resolve({ port, url });
        });

        timeout = window.setTimeout(() => {
          if (serverSettled) {
            return;
          }

          serverSettled = true;
          unsubscribe();
          reject(
            new WebContainerRuntimeError(
              "dev_server_failed",
              "等待开发服务器就绪超时。",
              {
                detail: `在 ${this.dependencies.serverReadyTimeoutMs}ms 内未收到 server-ready 事件。`,
              },
            ),
          );
        }, this.dependencies.serverReadyTimeoutMs);
      },
    );

    const process = await instance.spawn("npm", ["run", "dev"]);
    this.devProcess = process;
    // dev server 是常驻进程，输出流通常不会结束，因此这里只后台消费，不能 await 后再等就绪事件。
    void this.consumeProcessOutput(process, "dev", generation);

    // exit 同时覆盖两种情况：就绪前退出应拒绝 start；就绪后退出则把已展示的预览标记为失效。
    void process.exit.then((exitCode) => {
      if (generation !== this.generation) {
        return;
      }

      if (!serverSettled) {
        serverSettled = true;
        unsubscribe();
        if (timeout !== undefined) {
          window.clearTimeout(timeout);
        }
        rejectReady(
          new WebContainerRuntimeError(
            "dev_server_failed",
            `开发服务器在就绪前退出，退出码 ${exitCode}。`,
          ),
        );
        return;
      }

      if (this.snapshot.phase === "ready") {
        this.fail(
          new WebContainerRuntimeError(
            "dev_server_failed",
            `开发服务器已停止，退出码 ${exitCode}。`,
          ),
        );
      }
    });

    return serverReady;
  }

  private async consumeProcessOutput(
    process: WebContainerProcessAdapter,
    source: "install" | "dev",
    generation: number,
  ): Promise<void> {
    try {
      await process.output.pipeTo(
        new WritableStream<string>({
          write: (chunk) => {
            if (generation !== this.generation) {
              return;
            }

            // 终端控制符和 npm 单字符 spinner 对诊断没有价值，还会污染浏览器文本布局。
            // 按行清洗后再写入 snapshot，可让真实错误内容保持可复制、可测试。
            for (const line of chunk
              .replace(ANSI_ESCAPE_PATTERN, "")
              .split(/\r?\n/)
              .map((value) => value.trimEnd())
              .filter(
                (value) =>
                  value.length > 0 && !NPM_SPINNER_LINE_PATTERN.test(value),
              )) {
              this.appendLog(`[${source}] ${line}`);
              if (source === "dev") {
                this.captureForwardedPreviewError(line);
              }
            }
          },
        }),
      );
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }

      // 输出流中断不一定代表进程退出；记录辅助信息即可，最终状态仍由 exit/server-ready 决定。
      this.appendLog(
        `[runtime] 无法继续读取 ${source} 输出：${getErrorDetail(error) ?? "未知错误"}`,
      );
    }
  }

  private assertGeneration(generation: number): void {
    // JavaScript Promise 无法统一取消，这个检查点负责阻止被替代的异步链继续推进状态机。
    if (generation !== this.generation) {
      throw new WebContainerRuntimeError(
        "dev_server_failed",
        "本次 WebContainer 启动已被新的运行请求替代。",
      );
    }
  }

  private setPhase(phase: WebContainerPhase): void {
    this.setSnapshot({
      ...this.snapshot,
      phase,
      diagnostic: null,
    });
  }

  private appendLog(line: string): void {
    this.setSnapshot({
      ...this.snapshot,
      // 始终保留最近日志，既控制内存，也保留最接近失败点的上下文。
      logs: [...this.snapshot.logs, line].slice(-MAX_LOG_LINES),
    });
  }

  private captureForwardedPreviewError(line: string): void {
    const match = FORWARDED_BROWSER_ERROR_PATTERN.exec(line);
    if (!match?.[1]) {
      return;
    }

    this.setSnapshot({
      ...this.snapshot,
      forwardedPreviewErrors: [
        ...this.snapshot.forwardedPreviewErrors,
        {
          revision: this.snapshot.syncedRevision,
          message: match[1],
          timestamp: Date.now(),
        },
      ].slice(-50),
    });
  }

  private fail(error: WebContainerRuntimeError): void {
    // 错误既进入终端时间线，也进入结构化 Diagnostics，兼顾排障上下文和 UI 展示。
    this.appendLog(`[error] ${error.diagnostic.message}`);
    this.setSnapshot({
      ...this.snapshot,
      phase: "failed",
      previewUrl: null,
      port: null,
      diagnostic: error.diagnostic,
    });
  }

  private setSnapshot(snapshot: WebContainerRuntimeSnapshot): void {
    this.snapshot = snapshot;
    // 同步通知订阅者，保证 React 读取到的就是刚替换的新快照，不出现中间可变状态。
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const webContainerRuntimeManager = new WebContainerRuntimeManager();

// 只导出项目自己的最小接口，避免上层组件依赖 WebContainer SDK 的具体实现。
export type WebContainerInstance = WebContainerAdapter;

function flattenRuntimeTree(
  tree: FileSystemTree,
  parentPath = "",
  files = new Map<string, string>(),
): Map<string, string> {
  for (const [name, entry] of Object.entries(tree)) {
    const path = parentPath ? `${parentPath}/${name}` : name;

    if ("file" in entry && "contents" in entry.file) {
      files.set(path, entry.file.contents.toString());
      continue;
    }

    if ("directory" in entry) {
      flattenRuntimeTree(entry.directory, path, files);
    }
  }

  return files;
}

function delayMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(createError()), timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
