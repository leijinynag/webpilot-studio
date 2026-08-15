import type {
  FileSystemTree,
  SpawnOptions,
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
import type { ShowcaseArtifact } from "@/infrastructure/showcase/artifact";
import { createShowcaseArtifact } from "@/infrastructure/showcase/artifact";
import type {
  RuntimeFileDiff,
  RuntimeFileDiffEntry,
} from "@/domains/project/types";

type RuntimeListener = () => void;
type ServerReadyListener = (port: number, url: string) => void;
type ProcessOutputListener = (chunk: string) => void;
type ProcessExitListener = (state: WebContainerProcessExitState) => void;

export type WebContainerProcessExitState =
  | { status: "running"; code: null; error: null }
  | { status: "exited"; code: number; error: null }
  | { status: "failed"; code: null; error: string };

/**
 * SDK 原生进程把输入、输出直接暴露为 Web Streams。项目层改为小型适配器：
 * - 输出只读取一次，再广播给 Runtime 日志与 xterm，避免 ReadableStream 被重复锁定；
 * - 每次 input 都短暂获取 writer，组件重挂载不会遗留永久锁；
 * - exit rejection 会被适配层观察，用户停止进程时不会产生未处理异常。
 */
export type WebContainerProcessAdapter = {
  readonly exit: Promise<number>;
  input(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  kill(): void;
  subscribeOutput(
    listener: ProcessOutputListener,
    options?: { replay?: boolean },
  ): () => void;
  subscribeExit(listener: ProcessExitListener): () => void;
  getExitState(): WebContainerProcessExitState;
  waitForOutput(): Promise<void>;
};

export type WebContainerAdapter = {
  mount(tree: FileSystemTree): Promise<void>;
  spawn(
    command: string,
    args: string[],
    options?: SpawnOptions,
  ): Promise<WebContainerProcessAdapter>;
  on(event: "server-ready", listener: ServerReadyListener): () => void;
  fs: {
    readdir(
      path: string,
      options: { withFileTypes: true },
    ): Promise<Array<{ name: string; isDirectory(): boolean }>>;
    readFile(path: string): Promise<Uint8Array>;
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

/**
 * 运行时资产只保存短期下载地址和内容摘要。
 *
 * assetPath 是项目代码使用的稳定路径，downloadUrl 只在宿主页面内读取，
 * downloadedBytes 不进入 Repository，也不会被发送给 Agent。
 */
export type WebContainerRuntimeAsset = {
  id: string;
  assetPath: string;
  downloadUrl: string;
  mimeType: string;
  originalFilename: string | null;
  sha256: string;
};

// 浏览器能力检测与 boot 行为都通过依赖注入进入 Manager。
// 生产环境使用真实实现，测试环境则可以稳定覆盖隔离失败、安装失败和超时等分支。
export type WebContainerRuntimeDependencies = {
  boot: () => Promise<WebContainerAdapter>;
  isCrossOriginIsolated: () => boolean;
  installTimeoutMs?: number;
  serverReadyTimeoutMs?: number;
  productionBuildTimeoutMs?: number;
};

export type ProductionBuildResult = ShowcaseArtifact & {
  buildDurationMs: number;
  logs: string[];
};

// 日志属于高频状态，必须设置上限，避免长时间运行后 snapshot 无限增长并拖慢 React 更新。
const MAX_LOG_LINES = 160;
const MAX_PROCESS_REPLAY_CHARACTERS = 128_000;
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
const RUNTIME_DIFF_IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "cache",
  "coverage",
  "dist",
  "node_modules",
]);
const MAX_RUNTIME_DIFF_FILE_BYTES = 2 * 1024 * 1024;

async function bootWebContainer(): Promise<WebContainerAdapter> {
  // 动态加载确保 Next.js 服务端构建阶段不会执行依赖浏览器环境的 WebContainer 代码。
  const { WebContainer } = await import("@webcontainer/api");

  const instance = await WebContainer.boot({
    // 与 next.config.ts 返回的 COEP 响应头保持一致，SharedArrayBuffer 才能在页面中使用。
    coep: "require-corp",
    // 将预览页中的编译和运行异常转交宿主页面，后续可统一接入 Diagnostics。
    forwardPreviewErrors: true,
    workdirName: "webpilot-preview",
  });

  // WebContainer 本身仍由 infrastructure 层持有。业务代码只接触稳定的
  // Adapter 契约，SDK 升级导致的流接口变化不会扩散到 React 组件。
  return {
    mount: (tree) => instance.mount(tree),
    spawn: async (command, args, options) =>
      createWebContainerProcessAdapter(
        await instance.spawn(command, args, options),
      ),
    on: (event, listener) => instance.on(event, listener),
    fs: instance.fs,
    teardown: () => instance.teardown(),
  };
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
  private installProcess: WebContainerProcessAdapter | null = null;
  private devProcess: WebContainerProcessAdapter | null = null;
  // 交互式终端与 dev server 共用同一 WebContainer，但生命周期彼此独立。
  // React 面板卸载时不停止 jsh；只有显式重启、项目切换或 teardown 才终止它。
  private terminalProcess: WebContainerProcessAdapter | null = null;
  private terminalStartPromise: Promise<WebContainerProcessAdapter> | null =
    null;
  // ready 状态只对当前项目有效；切换项目必须销毁旧容器，避免 mount 合并出跨项目残留文件。
  private activeProjectKey: string | null = null;
  // Repository revision 与运行镜像身份并不总是一一对应。run_preview 会在相同
  // revision 上临时注入 Bridge，因此需要独立 key 触发同步，不能把它误判为旧镜像。
  private activeRuntimeKey: string | null = null;
  // mountedFiles 记录运行镜像当前内容，增量同步时据此识别新增、修改和删除。
  private mountedFiles = new Map<string, string>();
  // 二进制资产独立于源码快照维护。这样图片变化不会被误判成源码 revision，
  // 也不会因为重新同步代码而重复写入相同内容。
  private mountedAssets = new Map<string, { path: string; sha256: string }>();
  private mountedAssetsFingerprint = "";
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
      productionBuildTimeoutMs:
        dependencies?.productionBuildTimeoutMs ?? 180_000,
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

  /**
   * Preview 首次进入只选择项目上下文，不启动 WebContainer。若标签页此前运行过
   * 另一个项目，则释放旧容器，避免新项目短暂显示旧 iframe 或继续消费旧进程。
   */
  activateProject(projectKey: string): void {
    if (
      this.activeProjectKey !== null &&
      this.activeProjectKey !== projectKey
    ) {
      this.teardown();
    }
  }

  /**
   * 组件切换 Code/Preview 时可能卸载后重建。通过 Manager 中的项目身份恢复
   * “该项目已经显式启动”这一事实，而不是因 React 本地 state 丢失而重复安装。
   */
  isActiveProject(projectKey: string): boolean {
    return (
      this.activeProjectKey === projectKey && this.snapshot.phase !== "idle"
    );
  }

  /**
   * 在当前项目运行镜像中启动交互式 jsh。
   *
   * 同一标签页只保留一个终端进程；重复打开只同步最新尺寸并复用输出历史。
   * generation 校验阻止项目切换期间迟到的 spawn 重新挂到新项目界面。
   */
  startTerminal(input: {
    projectKey: string;
    cols: number;
    rows: number;
  }): Promise<WebContainerProcessAdapter> {
    const cols = normalizeTerminalDimension(input.cols, 80);
    const rows = normalizeTerminalDimension(input.rows, 24);

    if (
      !this.instance ||
      this.activeProjectKey !== input.projectKey ||
      this.snapshot.phase !== "ready"
    ) {
      return Promise.reject(
        new WebContainerRuntimeError(
          "terminal_unavailable",
          "项目运行环境尚未就绪，暂时无法打开终端。",
        ),
      );
    }

    if (
      this.terminalProcess &&
      this.terminalProcess.getExitState().status === "running"
    ) {
      this.terminalProcess.resize(cols, rows);
      return Promise.resolve(this.terminalProcess);
    }

    if (this.terminalStartPromise) {
      return this.terminalStartPromise.then((process) => {
        process.resize(cols, rows);
        return process;
      });
    }

    const generation = this.generation;
    const instance = this.instance;
    this.appendLog("[terminal] 正在启动交互式 jsh...");
    const currentStart = instance
      .spawn("jsh", [], {
        terminal: { cols, rows },
      })
      .then((process) => {
        if (
          generation !== this.generation ||
          this.activeProjectKey !== input.projectKey
        ) {
          process.kill();
          this.assertGeneration(generation);
        }

        this.terminalProcess = process;
        process.subscribeExit((state) => {
          if (
            generation !== this.generation ||
            state.status === "running" ||
            this.terminalProcess !== process
          ) {
            return;
          }

          this.terminalProcess = null;
          this.appendLog(
            state.status === "exited"
              ? `[terminal] jsh 已退出，退出码 ${state.code}。`
              : `[terminal] jsh 异常中止：${state.error}`,
          );
        });
        this.appendLog("[terminal] 交互式 jsh 已连接。");
        return process;
      })
      .finally(() => {
        if (this.terminalStartPromise === currentStart) {
          this.terminalStartPromise = null;
        }
      });
    this.terminalStartPromise = currentStart;

    return currentStart;
  }

  /**
   * 重启只影响交互式 shell，不触碰 dev server、已安装依赖或 Repository 镜像。
   */
  restartTerminal(input: {
    projectKey: string;
    cols: number;
    rows: number;
  }): Promise<WebContainerProcessAdapter> {
    this.stopTerminal();
    return this.startTerminal(input);
  }

  stopTerminal(): void {
    this.terminalProcess?.kill();
    this.terminalProcess = null;
  }

  start(
    tree: FileSystemTree = WEBPILOT_RSBUILD_TEMPLATE,
    projectKey = "default-template",
    revision: number | null = null,
    runtimeKey = `revision:${revision ?? "unknown"}`,
    assets: readonly WebContainerRuntimeAsset[] = [],
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
      if (this.activeRuntimeKey === runtimeKey) {
        return assetsMatch(this.mountedAssetsFingerprint, assets)
          ? Promise.resolve(this.snapshot)
          : this.syncAssets(assets, projectKey);
      }

      return this.syncRevision(tree, projectKey, revision, runtimeKey).then(
        () => this.syncAssets(assets, projectKey),
      );
    }

    // Strict Mode、多个预览消费者或用户连续点击重试都可能同时调用 start。
    // 若后来的请求携带不同 runtimeKey，则在当前启动完成后补一次增量同步。
    // 这覆盖“普通 Preview 正在安装时 Agent 请求注入 Bridge”的真实竞态。
    if (this.startPromise) {
      return this.startPromise.then(() => {
        if (this.activeProjectKey !== projectKey) {
          return this.start(tree, projectKey, revision, runtimeKey, assets);
        }

        return this.activeRuntimeKey === runtimeKey
          ? assetsMatch(this.mountedAssetsFingerprint, assets)
            ? this.snapshot
            : this.syncAssets(assets, projectKey)
          : this.start(tree, projectKey, revision, runtimeKey, assets);
      });
    }

    this.activeProjectKey = projectKey;
    const currentStart = this.startRuntime(
      tree,
      revision,
      runtimeKey,
      assets,
    ).finally(() => {
      // 旧项目的 finally 可能晚于新项目启动；只允许当前 Promise 清理自己的锁。
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
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
    assets: readonly WebContainerRuntimeAsset[] = [],
  ): Promise<WebContainerRuntimeSnapshot> {
    if (this.activeProjectKey !== projectKey) {
      return this.start(tree, projectKey, revision, runtimeKey, assets);
    }

    const queuedSync = this.syncTail.then(
      () =>
        this.performSyncRevision(
          tree,
          projectKey,
          revision,
          runtimeKey,
          assets,
        ),
      () =>
        this.performSyncRevision(
          tree,
          projectKey,
          revision,
          runtimeKey,
          assets,
        ),
    );
    // 单次同步失败仍应原样返回给调用方，但不能让队列永久停在 rejected。
    this.syncTail = queuedSync.then(
      () => undefined,
      () => undefined,
    );

    return queuedSync;
  }

  /**
   * 将项目私有资产同步到 WebContainer 的 public 目录。
   *
   * 下载发生在宿主页面，写入发生在 WebContainer。两者共用 syncTail，
   * 因而不会和 Repository 文件同步交错覆盖。相同 sha256 的资产只保留
   * 元数据，不重复发起下载或 fs.writeFile。
   */
  syncAssets(
    assets: readonly WebContainerRuntimeAsset[],
    projectKey: string,
  ): Promise<WebContainerRuntimeSnapshot> {
    const queuedSync = this.syncTail.then(
      () => this.performSyncAssets(assets, projectKey),
      () => this.performSyncAssets(assets, projectKey),
    );
    this.syncTail = queuedSync.then(
      () => undefined,
      () => undefined,
    );
    return queuedSync;
  }

  /**
   * 检测终端对 WebContainer 工作区造成的临时修改。
   *
   * 扫描与 Repository 同步共用 syncTail，避免一边写入新 revision、一边读取旧目录。
   * mountedFiles 只在 Repository 同步成功后更新，因此天然是运行时修改的稳定基线；
   * 本方法只返回 Diff，不修改基线，也不会把终端内容直接写回 Repository。
   */
  detectRuntimeChanges(input: {
    projectKey: string;
  }): Promise<RuntimeFileDiff> {
    if (
      !this.instance ||
      this.activeProjectKey !== input.projectKey ||
      this.snapshot.phase !== "ready" ||
      this.snapshot.syncedRevision === null
    ) {
      return Promise.reject(
        new WebContainerRuntimeError(
          "runtime_scan_unavailable",
          "项目运行环境尚未同步到可审查的 Repository revision。",
        ),
      );
    }

    // 在进入队列前固定扫描身份。若排队或递归读取期间发生项目切换、teardown
    // 或新 revision 同步，结果会被视为过期，不能交给用户继续导入。
    const generation = this.generation;
    const projectKey = input.projectKey;
    const baseRevision = this.snapshot.syncedRevision;
    const instance = this.instance;
    const baseline = new Map(this.mountedFiles);
    const queuedScan = this.syncTail.then(
      () =>
        this.performRuntimeChangeScan({
          instance,
          projectKey,
          generation,
          baseRevision,
          baseline,
        }),
      () =>
        this.performRuntimeChangeScan({
          instance,
          projectKey,
          generation,
          baseRevision,
          baseline,
        }),
    );
    this.syncTail = queuedScan.then(
      () => undefined,
      () => undefined,
    );

    return queuedScan;
  }

  /**
   * 生产构建是发布动作的一部分，只有 Publish 页面显式调用才会执行。
   * 构建前复用当前项目的 boot/mount/install 结果，随后停止常驻 dev server，
   * 读取 dist 文件并交给 Showcase artifact 层打包。
   */
  async buildProduction(
    tree: FileSystemTree = WEBPILOT_RSBUILD_TEMPLATE,
    projectKey = "default-template",
    revision: number | null = null,
    runtimeKey = `production:${revision ?? "unknown"}`,
    assets: readonly WebContainerRuntimeAsset[] = [],
  ): Promise<ProductionBuildResult> {
    await this.start(tree, projectKey, revision, runtimeKey, assets);

    if (!this.instance || this.activeProjectKey !== projectKey) {
      throw new WebContainerRuntimeError(
        "dev_server_failed",
        "生产构建没有可用的 WebContainer 实例。",
      );
    }

    const buildStartedAt = Date.now();
    const buildLogs: string[] = [];
    this.devProcess?.kill();
    this.devProcess = null;
    this.appendLog("[build] 停止开发服务器，开始 production build...");

    const process = await this.instance.spawn("npm", ["run", "build"]);
    const outputPromise = this.consumeProcessOutput(
      process,
      "build",
      this.generation,
      buildLogs,
    );
    const exitCode = await withTimeout(
      process.exit,
      this.dependencies.productionBuildTimeoutMs,
      () =>
        new WebContainerRuntimeError(
          "dev_server_failed",
          "生产构建超时，未能生成可发布产物。",
          {
            detail: `npm run build 在 ${this.dependencies.productionBuildTimeoutMs}ms 内未退出。`,
          },
        ),
    );

    await Promise.race([outputPromise, delayMilliseconds(500)]);

    if (exitCode !== 0) {
      throw new WebContainerRuntimeError(
        "dev_server_failed",
        `生产构建失败，退出码 ${exitCode}。`,
        { detail: buildLogs.at(-1) },
      );
    }

    const outputFiles = await readDirectoryTree(this.instance, "dist");
    const artifact = await createShowcaseArtifact(outputFiles);
    this.appendLog(
      `[build] production build 完成，共 ${artifact.manifest.files.length} 个文件。`,
    );

    return {
      ...artifact,
      buildDurationMs: Date.now() - buildStartedAt,
      logs: buildLogs,
    };
  }

  private async performSyncRevision(
    tree: FileSystemTree,
    projectKey: string,
    revision: number | null,
    runtimeKey: string,
    assets: readonly WebContainerRuntimeAsset[],
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
      return this.start(tree, projectKey, revision, runtimeKey, assets);
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
      return this.start(tree, projectKey, revision, runtimeKey, assets);
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

  private async performRuntimeChangeScan(input: {
    instance: WebContainerAdapter;
    projectKey: string;
    generation: number;
    baseRevision: number;
    baseline: Map<string, string>;
  }): Promise<RuntimeFileDiff> {
    this.assertRuntimeScanIdentity(input);
    const runtimeFiles = await readRuntimeTextFiles(input.instance);
    this.assertRuntimeScanIdentity(input);

    const entries: RuntimeFileDiffEntry[] = [];
    for (const [path, content] of runtimeFiles) {
      const beforeContent = input.baseline.get(path);
      if (beforeContent === undefined) {
        entries.push({
          path,
          status: "added",
          beforeContent: null,
          afterContent: content,
        });
      } else if (beforeContent !== content) {
        entries.push({
          path,
          status: "modified",
          beforeContent,
          afterContent: content,
        });
      }
    }

    for (const [path, content] of input.baseline) {
      if (
        shouldIgnoreRuntimeDiffPath(path, false) ||
        runtimeFiles.has(path)
      ) {
        continue;
      }

      entries.push({
        path,
        status: "deleted",
        beforeContent: content,
        afterContent: null,
      });
    }

    entries.sort((left, right) => left.path.localeCompare(right.path));
    return {
      projectKey: input.projectKey,
      baseRevision: input.baseRevision,
      entries,
    };
  }

  /**
   * 扫描结果只有在项目、容器 generation 和 Repository revision 全部未变化时有效。
   * 这里不复用 assertGeneration 的通用异常，便于 UI 明确提示用户重新检测 Diff。
   */
  private assertRuntimeScanIdentity(input: {
    instance: WebContainerAdapter;
    projectKey: string;
    generation: number;
    baseRevision: number;
  }): void {
    if (
      this.instance !== input.instance ||
      this.generation !== input.generation ||
      this.activeProjectKey !== input.projectKey ||
      this.snapshot.phase !== "ready" ||
      this.snapshot.syncedRevision !== input.baseRevision
    ) {
      throw new WebContainerRuntimeError(
        "runtime_scan_unavailable",
        "运行环境在检测期间已经变化，请重新检测运行时文件。",
      );
    }
  }

  private async performSyncAssets(
    assets: readonly WebContainerRuntimeAsset[],
    projectKey: string,
  ): Promise<WebContainerRuntimeSnapshot> {
    if (this.activeProjectKey !== projectKey) {
      return this.snapshot;
    }

    if (!this.instance || this.snapshot.phase !== "ready") {
      return this.snapshot;
    }

    const nextAssets = new Map(
      assets.map((asset) => [asset.id, asset] as const),
    );
    try {
      for (const [assetId, mounted] of this.mountedAssets) {
        if (!nextAssets.has(assetId)) {
          await this.instance.fs.rm(mounted.path, { force: true });
          this.appendLog(`[asset] 删除 ${mounted.path}`);
        }
      }

      for (const asset of nextAssets.values()) {
        const targetPath = toRuntimeAssetFilePath(asset);
        const mounted = this.mountedAssets.get(asset.id);
        if (mounted?.path === targetPath && mounted.sha256 === asset.sha256) {
          continue;
        }

        const response = await fetch(asset.downloadUrl, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new WebContainerRuntimeError(
            "asset_sync_failed",
            `资产 ${asset.originalFilename ?? asset.id} 加载失败。`,
            {
              detail: `下载资产返回 HTTP ${response.status}，请刷新资产列表后重试。`,
            },
          );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        const parent = targetPath.split("/").slice(0, -1).join("/");
        if (parent) {
          await this.instance.fs.mkdir(parent, { recursive: true });
        }
        await this.instance.fs.writeFile(targetPath, bytes);
        this.appendLog(`[asset] 写入 ${targetPath}`);
      }

      this.mountedAssets = new Map(
        [...nextAssets.values()].map((asset) => [
          asset.id,
          { path: toRuntimeAssetFilePath(asset), sha256: asset.sha256 },
        ]),
      );
      this.mountedAssetsFingerprint = fingerprintAssets(assets);
      this.setSnapshot({ ...this.snapshot, diagnostic: null });
      return this.snapshot;
    } catch (error) {
      const runtimeError =
        error instanceof WebContainerRuntimeError
          ? error
          : new WebContainerRuntimeError(
              "asset_sync_failed",
              "项目图片资产未能同步到 Preview。",
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
    this.stopTerminal();
    this.terminalStartPromise = null;
    this.installProcess?.kill();
    this.installProcess = null;
    this.devProcess?.kill();
    this.devProcess = null;
    this.instance?.teardown();
    this.instance = null;
    this.bootPromise = null;
    this.startPromise = null;
    this.activeProjectKey = null;
    this.activeRuntimeKey = null;
    this.mountedFiles = new Map();
    this.mountedAssets = new Map();
    this.mountedAssetsFingerprint = "";
    this.setSnapshot(createInitialRuntimeSnapshot());
  }

  private async startRuntime(
    tree: FileSystemTree,
    revision: number | null,
    runtimeKey: string,
    assets: readonly WebContainerRuntimeAsset[] = [],
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
    this.installProcess?.kill();
    this.installProcess = null;
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
      await this.writeInitialAssets(instance, assets, generation);
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
      // teardown 可能恰好发生在 spawn Promise 已完成、当前 continuation 尚未恢复
      // 的窗口。此时进程还未登记到字段，必须在恢复后主动终止这份迟到资源。
      if (generation !== this.generation) {
        installProcess.kill();
        this.assertGeneration(generation);
      }
      this.installProcess = installProcess;
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
      // exit 已经 settle 后清除引用。后续 teardown 不必再操作已结束的安装进程。
      if (this.installProcess === installProcess) {
        this.installProcess = null;
      }
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

      // WebContainer 的 exit Promise 在网络阻塞时可能永远不结束。超时或任一
      // 启动阶段失败都必须主动终止安装进程，否则重试会与旧 npm 进程竞争资源。
      this.installProcess?.kill();
      this.installProcess = null;

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

  private async writeInitialAssets(
    instance: WebContainerAdapter,
    assets: readonly WebContainerRuntimeAsset[],
    generation: number,
  ): Promise<void> {
    if (assets.length === 0) {
      this.mountedAssets = new Map();
      this.mountedAssetsFingerprint = "";
      return;
    }

    this.appendLog(`[asset] 准备同步 ${assets.length} 个项目资产...`);
    for (const asset of assets) {
      this.assertGeneration(generation);
      const targetPath = toRuntimeAssetFilePath(asset);
      const response = await fetch(asset.downloadUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new WebContainerRuntimeError(
          "asset_sync_failed",
          `资产 ${asset.originalFilename ?? asset.id} 加载失败。`,
          {
            detail: `下载资产返回 HTTP ${response.status}，请刷新资产列表后重试。`,
          },
        );
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const parent = targetPath.split("/").slice(0, -1).join("/");
      if (parent) {
        await instance.fs.mkdir(parent, { recursive: true });
      }
      await instance.fs.writeFile(targetPath, bytes);
      this.appendLog(`[asset] 写入 ${targetPath}`);
    }
    this.mountedAssets = new Map(
      assets.map((asset) => [
        asset.id,
        { path: toRuntimeAssetFilePath(asset), sha256: asset.sha256 },
      ]),
    );
    this.mountedAssetsFingerprint = fingerprintAssets(assets);
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
    void process.exit.then(
      (exitCode) => {
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
      },
      (error: unknown) => {
        // teardown/项目切换会先递增 generation 再 kill 进程。WebContainer 此时
        // 以 rejected "Process aborted" 表示预期取消，观察并吞掉即可，不能污染宿主控制台。
        if (generation !== this.generation) {
          return;
        }

        const runtimeError = new WebContainerRuntimeError(
          "dev_server_failed",
          serverSettled
            ? "开发服务器进程异常中止。"
            : "开发服务器在就绪前异常中止。",
          {
            cause: error,
            detail: getErrorDetail(error),
          },
        );

        if (!serverSettled) {
          serverSettled = true;
          unsubscribe();
          if (timeout !== undefined) {
            window.clearTimeout(timeout);
          }
          rejectReady(runtimeError);
          return;
        }

        if (this.snapshot.phase === "ready") {
          this.fail(runtimeError);
        }
      },
    );

    return serverReady;
  }

  private async consumeProcessOutput(
    process: WebContainerProcessAdapter,
    source: "install" | "dev" | "build",
    generation: number,
    collectedLogs?: string[],
  ): Promise<void> {
    const unsubscribe = process.subscribeOutput((chunk) => {
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
        collectedLogs?.push(line);
        if (source === "dev") {
          this.captureForwardedPreviewError(line);
        }
      }
    });

    try {
      await process.waitForOutput();
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }

      // 输出流中断不一定代表进程退出；记录辅助信息即可，最终状态仍由 exit/server-ready 决定。
      this.appendLog(
        `[runtime] 无法继续读取 ${source} 输出：${getErrorDetail(error) ?? "未知错误"}`,
      );
    } finally {
      unsubscribe();
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

type WebContainerRuntimeGlobal = typeof globalThis & {
  __webpilotWebContainerRuntimeManager?: WebContainerRuntimeManager;
};

const runtimeGlobal = globalThis as WebContainerRuntimeGlobal;

/**
 * Next.js 开发环境的 Fast Refresh 可能重新执行客户端模块。如果每次都创建新
 * Manager，旧 WebContainer 仍在运行，但 React 会看到一份 idle 快照并再次安装。
 *
 * 浏览器全局只保存当前标签页的 Manager，不跨刷新、更不写入持久化存储。生产
 * 路由切换与开发热更新因此都能尽量复用同一份进程、URL 和运行镜像。
 */
export const webContainerRuntimeManager =
  runtimeGlobal.__webpilotWebContainerRuntimeManager ??
  new WebContainerRuntimeManager();

if (typeof window !== "undefined") {
  runtimeGlobal.__webpilotWebContainerRuntimeManager =
    webContainerRuntimeManager;
}

// 只导出项目自己的最小接口，避免上层组件依赖 WebContainer SDK 的具体实现。
export type WebContainerInstance = WebContainerAdapter;

/**
 * 将 SDK WebContainerProcess 转成可多订阅的进程适配器。
 *
 * outputPump 在创建时立即读取原始流，并保留有限回放缓冲。这样极快命令即使在
 * React 完成订阅前已经输出，也不会丢失首屏提示；缓冲有硬上限，长时间终端不会
 * 让宿主页面内存无限增长。
 */
function createWebContainerProcessAdapter(
  process: WebContainerProcess,
): WebContainerProcessAdapter {
  const outputListeners = new Set<ProcessOutputListener>();
  const exitListeners = new Set<ProcessExitListener>();
  let replayBuffer = "";
  let exitState: WebContainerProcessExitState = {
    status: "running",
    code: null,
    error: null,
  };

  const outputResult = process.output.pipeTo(
    new WritableStream<string>({
      write(chunk) {
        replayBuffer = `${replayBuffer}${chunk}`.slice(
          -MAX_PROCESS_REPLAY_CHARACTERS,
        );
        for (const listener of outputListeners) {
          listener(chunk);
        }
      },
    }),
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  // 这里始终注册 rejection 分支。WebContainer 在 kill 后可能 reject exit，
  // 适配层将其归一化成状态，而不是把预期的用户操作泄漏成 unhandled rejection。
  void process.exit.then(
    (code) => {
      exitState = { status: "exited", code, error: null };
      for (const listener of exitListeners) {
        listener(exitState);
      }
    },
    (error: unknown) => {
      exitState = {
        status: "failed",
        code: null,
        error: getErrorDetail(error) ?? "进程异常中止",
      };
      for (const listener of exitListeners) {
        listener(exitState);
      }
    },
  );

  return {
    exit: process.exit,
    async input(data) {
      const writer = process.input.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    },
    resize(cols, rows) {
      process.resize({
        cols: normalizeTerminalDimension(cols, 80),
        rows: normalizeTerminalDimension(rows, 24),
      });
    },
    kill: () => process.kill(),
    subscribeOutput(listener, options) {
      outputListeners.add(listener);
      if (options?.replay !== false && replayBuffer.length > 0) {
        listener(replayBuffer);
      }
      return () => {
        outputListeners.delete(listener);
      };
    },
    subscribeExit(listener) {
      exitListeners.add(listener);
      listener(exitState);
      return () => {
        exitListeners.delete(listener);
      };
    },
    getExitState: () => exitState,
    async waitForOutput() {
      const result = await outputResult;
      if (!result.ok) {
        throw result.error;
      }
    },
  };
}

function normalizeTerminalDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function toRuntimeAssetFilePath(asset: WebContainerRuntimeAsset): string {
  const normalized = asset.assetPath.replace(/^\/+/, "");
  if (
    !normalized.startsWith("__webpilot/assets/") ||
    normalized.includes("..") ||
    normalized.includes("\\")
  ) {
    throw new WebContainerRuntimeError(
      "asset_sync_failed",
      "项目资产路径不合法，无法写入 Preview。",
    );
  }

  return `public/${normalized}`;
}

function fingerprintAssets(
  assets: readonly WebContainerRuntimeAsset[],
): string {
  return assets
    .map((asset) => `${asset.id}:${asset.assetPath}:${asset.sha256}`)
    .sort()
    .join("|");
}

function assetsMatch(
  currentFingerprint: string,
  assets: readonly WebContainerRuntimeAsset[],
): boolean {
  return currentFingerprint === fingerprintAssets(assets);
}

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

async function readDirectoryTree(
  instance: WebContainerAdapter,
  directory: string,
  parentPath = "",
  files: Array<{ path: string; content: Uint8Array }> = [],
): Promise<Array<{ path: string; content: Uint8Array }>> {
  // WebContainer 的 readdir 不会携带父级上下文。递归进入子目录时必须读取
  // 当前绝对目录，否则会重复读取 dist 根目录，并把 index.html 等根文件错误地
  // 拼成 dist/static/index.html。
  const currentDirectory = parentPath
    ? `${directory}/${parentPath}`
    : directory;
  const entries = await instance.fs.readdir(currentDirectory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const relativePath = parentPath
      ? `${parentPath}/${entry.name}`
      : entry.name;
    const absolutePath = `${directory}/${relativePath}`;

    if (entry.isDirectory()) {
      await readDirectoryTree(instance, directory, relativePath, files);
      continue;
    }

    files.push({
      path: relativePath,
      content: await instance.fs.readFile(absolutePath),
    });
  }

  return files;
}

async function readRuntimeTextFiles(
  instance: WebContainerAdapter,
  directory = ".",
  relativeDirectory = "",
  files = new Map<string, string>(),
): Promise<Map<string, string>> {
  const entries = await instance.fs.readdir(directory, {
    withFileTypes: true,
  });

  // WebContainer 返回顺序不属于稳定契约。显式排序既让 Diff UI 稳定，
  // 也让测试和后续批量 mutation 的 changedPaths 不受文件系统实现影响。
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (shouldIgnoreRuntimeDiffPath(relativePath, entry.isDirectory())) {
      continue;
    }

    const absolutePath =
      directory === "." ? relativePath : `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      await readRuntimeTextFiles(
        instance,
        absolutePath,
        relativePath,
        files,
      );
      continue;
    }

    const bytes = await instance.fs.readFile(absolutePath);
    const content = decodeRuntimeTextFile(bytes);
    if (content !== null) {
      files.set(relativePath, content);
    }
  }

  return files;
}

function shouldIgnoreRuntimeDiffPath(
  path: string,
  isDirectory: boolean,
): boolean {
  const normalized = path.replace(/^\.?\//, "");
  const segments = normalized.split("/").filter(Boolean);

  // Runtime Bridge 与私有图片资产都位于 public/__webpilot。它们由宿主页面注入，
  // 不属于用户源码，即使终端能看到也绝不能出现在导入候选中。
  if (
    normalized === "public/__webpilot" ||
    normalized.startsWith("public/__webpilot/")
  ) {
    return true;
  }

  if (
    segments.some((segment) =>
      RUNTIME_DIFF_IGNORED_DIRECTORIES.has(segment),
    )
  ) {
    return true;
  }

  if (isDirectory) {
    return false;
  }

  const filename = segments.at(-1) ?? "";
  return (
    filename === ".DS_Store" ||
    filename.endsWith(".log") ||
    /^npm-debug\.log(?:\.\d+)?$/.test(filename) ||
    /^pnpm-debug\.log(?:\.\d+)?$/.test(filename) ||
    /^yarn-(?:debug|error)\.log(?:\.\d+)?$/.test(filename)
  );
}

function decodeRuntimeTextFile(bytes: Uint8Array): string | null {
  if (bytes.byteLength > MAX_RUNTIME_DIFF_FILE_BYTES) {
    return null;
  }

  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\u0000")) {
      return null;
    }

    // 某些二进制恰好是合法 UTF-8。控制字符占比过高时仍按二进制处理，
    // 但保留源码中常见的换行、回车与制表符。
    let controlCharacters = 0;
    for (const character of content) {
      const code = character.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        controlCharacters += 1;
      }
    }
    if (
      controlCharacters >
      Math.max(4, Math.floor(content.length * 0.01))
    ) {
      return null;
    }

    return content;
  } catch {
    return null;
  }
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
