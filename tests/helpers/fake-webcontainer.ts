import type { FileSystemTree, SpawnOptions } from "@webcontainer/api";

import type {
  WebContainerAdapter,
  WebContainerProcessAdapter,
  WebContainerProcessExitState,
} from "@/infrastructure/webcontainer/runtime-manager";

export class FakeWebContainerProcess implements WebContainerProcessAdapter {
  readonly exit: Promise<number>;
  readonly inputs: string[] = [];
  readonly dimensions: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private readonly outputListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<
    (state: WebContainerProcessExitState) => void
  >();
  private replayBuffer = "";
  private readonly outputCompletion: Promise<void>;
  private exitState: WebContainerProcessExitState = {
    status: "running",
    code: null,
    error: null,
  };

  constructor(
    exitCode: number | Promise<number>,
    lines: string[] = [],
    outputCompletion?: Promise<void>,
  ) {
    this.exit = Promise.resolve(exitCode);
    // 默认让输出流与进程一起结束；需要模拟“exit 已完成但 stdout 未关闭”时，
    // 测试可以单独传入一个 pending Promise，保持两条生命周期彼此独立。
    this.outputCompletion =
      outputCompletion ?? this.exit.then(() => undefined);
    this.replayBuffer = lines.map((line) => `${line}\n`).join("");
    void this.exit.then(
      (code) => {
        this.exitState = { status: "exited", code, error: null };
        for (const listener of this.exitListeners) {
          listener(this.exitState);
        }
      },
      (error: unknown) => {
        this.exitState = {
          status: "failed",
          code: null,
          error: error instanceof Error ? error.message : String(error),
        };
        for (const listener of this.exitListeners) {
          listener(this.exitState);
        }
      },
    );
  }

  async input(data: string): Promise<void> {
    this.inputs.push(data);
  }

  resize(cols: number, rows: number): void {
    this.dimensions.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  subscribeOutput(
    listener: (chunk: string) => void,
    options?: { replay?: boolean },
  ): () => void {
    this.outputListeners.add(listener);
    if (options?.replay !== false && this.replayBuffer) {
      listener(this.replayBuffer);
    }
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  subscribeExit(
    listener: (state: WebContainerProcessExitState) => void,
  ): () => void {
    this.exitListeners.add(listener);
    listener(this.exitState);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  getExitState(): WebContainerProcessExitState {
    return this.exitState;
  }

  async waitForOutput(): Promise<void> {
    await this.outputCompletion;
  }

  emitOutput(chunk: string): void {
    this.replayBuffer += chunk;
    for (const listener of this.outputListeners) {
      listener(chunk);
    }
  }
}

// Fake 记录调用顺序而不模拟浏览器 Node.js 本身，测试重点因此落在 Manager 的编排契约。
export class FakeWebContainer implements WebContainerAdapter {
  readonly calls: string[] = [];
  mountedTree: FileSystemTree | null = null;
  installExitCode = 0;
  // dev server 在正常运行时不会退出。默认永不 settle，避免 ready 后立刻被标记为 failed。
  devExit: Promise<number> = new Promise<number>(() => undefined);
  terminalExit: Promise<number> = new Promise<number>(() => undefined);
  terminalProcess: FakeWebContainerProcess | null = null;
  previewUrl = "https://5173-webpilot.local";
  private readonly files = new Map<string, Uint8Array>();
  private serverReadyListener: ((port: number, url: string) => void) | null =
    null;
  readonly fs = {
    readdir: async (
      path: string,
      options: { withFileTypes: true },
    ): Promise<Array<{ name: string; isDirectory(): boolean }>> => {
      void options;
      const normalizedDirectory = normalizeFakePath(path);
      this.calls.push(`readdir:${normalizedDirectory || "."}`);
      const children = new Map<string, boolean>();

      for (const filePath of this.files.keys()) {
        if (
          normalizedDirectory &&
          !filePath.startsWith(`${normalizedDirectory}/`)
        ) {
          continue;
        }
        const relativePath = normalizedDirectory
          ? filePath.slice(normalizedDirectory.length + 1)
          : filePath;
        if (!relativePath) {
          continue;
        }
        const [name, ...remainingSegments] = relativePath.split("/");
        if (name) {
          children.set(name, remainingSegments.length > 0);
        }
      }

      return [...children.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, directory]) => ({
          name,
          isDirectory: () => directory,
        }));
    },
    readFile: async (path: string): Promise<Uint8Array> => {
      const normalizedPath = normalizeFakePath(path);
      this.calls.push(`read:${normalizedPath}`);
      const content = this.files.get(normalizedPath);
      if (!content) {
        throw new Error(`ENOENT: ${normalizedPath}`);
      }
      return new Uint8Array(content);
    },
    mkdir: async (path: string) => {
      this.calls.push(`mkdir:${path}`);
      return path;
    },
    rename: async (fromPath: string, toPath: string) => {
      const normalizedFromPath = normalizeFakePath(fromPath);
      const normalizedToPath = normalizeFakePath(toPath);
      this.calls.push(`rename:${normalizedFromPath}:${normalizedToPath}`);
      const content = this.files.get(normalizedFromPath);
      if (!content) {
        throw new Error(`ENOENT: ${normalizedFromPath}`);
      }
      this.files.delete(normalizedFromPath);
      this.files.set(normalizedToPath, content);
    },
    rm: async (
      path: string,
      options?: { force?: boolean; recursive?: boolean },
    ) => {
      void options;
      const normalizedPath = normalizeFakePath(path);
      this.calls.push(`rm:${normalizedPath}`);
      this.files.delete(normalizedPath);
      for (const filePath of [...this.files.keys()]) {
        if (filePath.startsWith(`${normalizedPath}/`)) {
          this.files.delete(filePath);
        }
      }
    },
    writeFile: async (path: string, content: string | Uint8Array) => {
      const normalizedPath = normalizeFakePath(path);
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : new Uint8Array(content);
      this.calls.push(
        `write:${normalizedPath}:${
          typeof content === "string" ? content : content.toString()
        }`,
      );
      this.files.set(normalizedPath, bytes);
    },
  };

  async mount(tree: FileSystemTree): Promise<void> {
    this.calls.push("mount");
    this.mountedTree = tree;
    this.files.clear();
    flattenFakeTree(tree, "", this.files);
  }

  async spawn(
    command: string,
    args: string[],
    options?: SpawnOptions,
  ): Promise<WebContainerProcessAdapter> {
    const invocation = [command, ...args].join(" ");
    this.calls.push(invocation);

    if (args[0] === "install") {
      return new FakeWebContainerProcess(this.installExitCode, [
        "|",
        "resolved packages",
        "dependencies installed",
      ]);
    }

    if (command === "jsh") {
      const process = new FakeWebContainerProcess(this.terminalExit, [
        "WebContainer shell ready",
      ]);
      if (options?.terminal) {
        process.resize(options.terminal.cols, options.terminal.rows);
      }
      this.terminalProcess = process;
      return process;
    }

    const process = new FakeWebContainerProcess(
      args[0] === "run" && args[1] === "dev" ? this.devExit : 0,
      [
        args[0] === "build"
          ? "production build complete"
          : "dev server starting",
      ],
    );

    if (args[0] === "run" && args[1] === "build") {
      this.setRuntimeFile("dist/index.html", "<html><body>built</body></html>");
      this.setRuntimeFile("dist/static/app.js", "console.log('built')");
    }

    // 使用 microtask 模拟 spawn 返回后异步触发 server-ready，
    // 同时验证 Manager 必须在 spawn 之前完成事件订阅。
    if (args[0] === "run" && args[1] === "dev") {
      queueMicrotask(() => {
        this.serverReadyListener?.(5173, this.previewUrl);
      });
    }
    return process;
  }

  on(
    event: "server-ready",
    listener: (port: number, url: string) => void,
  ): () => void {
    this.calls.push(`listen:${event}`);
    this.serverReadyListener = listener;

    return () => {
      this.serverReadyListener = null;
    };
  }

  teardown(): void {
    this.calls.push("teardown");
  }

  setRuntimeFile(path: string, content: string | Uint8Array): void {
    this.files.set(
      normalizeFakePath(path),
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content),
    );
  }

  deleteRuntimePath(path: string): void {
    const normalizedPath = normalizeFakePath(path);
    this.files.delete(normalizedPath);
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(`${normalizedPath}/`)) {
        this.files.delete(filePath);
      }
    }
  }
}

function normalizeFakePath(path: string): string {
  const normalized = path.replace(/^\.?\//, "").replace(/\/+$/, "");
  // WebContainer 以 "." 表示工作区根目录；Fake 内部使用空字符串表示根目录，
  // 两者必须在边界处归一化，否则递归扫描会把整个项目误判为已删除。
  return normalized === "." ? "" : normalized;
}

function flattenFakeTree(
  tree: FileSystemTree,
  parentPath: string,
  files: Map<string, Uint8Array>,
): void {
  for (const [name, entry] of Object.entries(tree)) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    if ("file" in entry && "contents" in entry.file) {
      const contents = entry.file.contents;
      files.set(
        path,
        typeof contents === "string"
          ? new TextEncoder().encode(contents)
          : new Uint8Array(contents),
      );
    } else if ("directory" in entry) {
      flattenFakeTree(entry.directory, path, files);
    }
  }
}
