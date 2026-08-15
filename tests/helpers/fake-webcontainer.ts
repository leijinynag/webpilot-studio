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
  private serverReadyListener: ((port: number, url: string) => void) | null =
    null;
  readonly fs = {
    readdir: async (
      path: string,
      options: { withFileTypes: true },
    ): Promise<Array<{ name: string; isDirectory(): boolean }>> => {
      void options;
      this.calls.push(`readdir:${path}`);
      if (path === "dist") {
        return [
          { name: "index.html", isDirectory: () => false },
          { name: "static", isDirectory: () => true },
        ];
      }
      if (path === "dist/static") {
        return [{ name: "app.js", isDirectory: () => false }];
      }
      return [];
    },
    readFile: async (path: string): Promise<Uint8Array> => {
      this.calls.push(`read:${path}`);
      if (path === "dist/static/app.js") {
        return new TextEncoder().encode("console.log('built')");
      }
      return new TextEncoder().encode("<html><body>built</body></html>");
    },
    mkdir: async (path: string) => {
      this.calls.push(`mkdir:${path}`);
      return path;
    },
    rename: async (fromPath: string, toPath: string) => {
      this.calls.push(`rename:${fromPath}:${toPath}`);
    },
    rm: async (path: string) => {
      this.calls.push(`rm:${path}`);
    },
    writeFile: async (path: string, content: string | Uint8Array) => {
      this.calls.push(`write:${path}:${content.toString()}`);
    },
  };

  async mount(tree: FileSystemTree): Promise<void> {
    this.calls.push("mount");
    this.mountedTree = tree;
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
}
