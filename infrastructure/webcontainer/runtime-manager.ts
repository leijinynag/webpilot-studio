import type {
  FileSystemTree,
  WebContainer,
  WebContainerProcess,
} from "@webcontainer/api";

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
  teardown(): void;
};

// 浏览器能力检测与 boot 行为都通过依赖注入进入 Manager。
// 生产环境使用真实实现，测试环境则可以稳定覆盖隔离失败、安装失败和超时等分支。
export type WebContainerRuntimeDependencies = {
  boot: () => Promise<WebContainerAdapter>;
  isCrossOriginIsolated: () => boolean;
  serverReadyTimeoutMs?: number;
};

// 日志属于高频状态，必须设置上限，避免长时间运行后 snapshot 无限增长并拖慢 React 更新。
const MAX_LOG_LINES = 160;
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const NPM_SPINNER_LINE_PATTERN = /^[|/\\-]$/;

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
  private devProcess: WebContainerProcessAdapter | null = null;
  // generation 是轻量取消令牌。teardown 或未来的新一轮启动会递增它，
  // 旧异步任务即使晚到，也不能再把过期结果写回当前 snapshot。
  private generation = 0;

  constructor(dependencies?: Partial<WebContainerRuntimeDependencies>) {
    this.dependencies = {
      boot: dependencies?.boot ?? bootWebContainer,
      isCrossOriginIsolated:
        dependencies?.isCrossOriginIsolated ?? isBrowserCrossOriginIsolated,
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
  ): Promise<WebContainerRuntimeSnapshot> {
    // ready 状态代表当前 dev server 仍由 Manager 持有，无需重复挂载和安装依赖。
    if (this.snapshot.phase === "ready") {
      return Promise.resolve(this.snapshot);
    }

    // Strict Mode、多个预览消费者或用户连续点击重试都可能同时调用 start。
    // 返回同一个 Promise 可以保证完整启动链在任一时刻最多执行一次。
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startRuntime(tree).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
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
    this.setSnapshot(createInitialRuntimeSnapshot());
  }

  private async startRuntime(
    tree: FileSystemTree,
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
      const instance = await this.getOrBootInstance();
      this.assertGeneration(generation);

      // mount、install、start 存在严格数据依赖：后一阶段只能在前一阶段成功后开始。
      // 保持串行也让 snapshot.phase 能准确指向实际失败位置。
      this.setPhase("mounting");
      this.appendLog("[runtime] 正在挂载固定 Rsbuild 项目模板...");
      await instance.mount(tree);
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
      await this.consumeProcessOutput(installProcess, "install");
      const installExitCode = await installProcess.exit;

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
      });
      this.appendLog(`[runtime] 预览服务已就绪：${server.url}`);

      return this.snapshot;
    } catch (error) {
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

  private async getOrBootInstance(): Promise<WebContainerAdapter> {
    if (this.instance) {
      this.appendLog("[runtime] 复用当前标签页中的 WebContainer 实例。");
      return this.instance;
    }

    // boot 本身也单独去重，避免未来出现“不启动项目、只预热容器”的调用后重复 boot。
    if (!this.bootPromise) {
      this.appendLog("[runtime] 正在 boot WebContainer...");
      this.bootPromise = this.dependencies
        .boot()
        .then((instance) => {
          this.instance = instance;
          return instance;
        })
        .catch((error: unknown) => {
          // boot 失败后清除缓存，允许用户修复环境后重新发起真正的新启动。
          this.bootPromise = null;
          throw error;
        });
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
    void this.consumeProcessOutput(process, "dev");

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
  ): Promise<void> {
    try {
      await process.output.pipeTo(
        new WritableStream<string>({
          write: (chunk) => {
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
            }
          },
        }),
      );
    } catch (error) {
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

// 只导出类型别名，避免上层组件依赖 WebContainer SDK 的具体实现。
export type WebContainerInstance = WebContainer;
