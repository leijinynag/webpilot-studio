import type { FileSystemTree } from "@webcontainer/api";

import type {
  WebContainerAdapter,
  WebContainerProcessAdapter,
} from "@/infrastructure/webcontainer/runtime-manager";

// 测试流按真实 WebContainer 的文本流形态逐行输出，让日志清洗逻辑也能被覆盖。
function createOutputStream(lines: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(`${line}\n`);
      }
      controller.close();
    },
  });
}

export class FakeWebContainerProcess implements WebContainerProcessAdapter {
  readonly exit: Promise<number>;
  readonly output: ReadableStream<string>;
  killed = false;

  constructor(exitCode: number, lines: string[] = []) {
    this.exit = Promise.resolve(exitCode);
    this.output = createOutputStream(lines);
  }

  kill(): void {
    this.killed = true;
  }
}

// Fake 记录调用顺序而不模拟浏览器 Node.js 本身，测试重点因此落在 Manager 的编排契约。
export class FakeWebContainer implements WebContainerAdapter {
  readonly calls: string[] = [];
  mountedTree: FileSystemTree | null = null;
  installExitCode = 0;
  // dev server 在正常运行时不会退出。默认永不 settle，避免 ready 后立刻被标记为 failed。
  devExit: Promise<number> = new Promise<number>(() => undefined);
  previewUrl = "https://5173-webpilot.local";
  private serverReadyListener: ((port: number, url: string) => void) | null =
    null;
  readonly fs = {
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
  ): Promise<WebContainerProcessAdapter> {
    const invocation = `${command} ${args.join(" ")}`;
    this.calls.push(invocation);

    if (args[0] === "install") {
      return new FakeWebContainerProcess(this.installExitCode, [
        "|",
        "resolved packages",
        "dependencies installed",
      ]);
    }

    const process = new FakeWebContainerProcess(0, ["dev server starting"]);
    // exit 在接口上是 readonly，这里用测试专用 Promise 替换默认的立即成功结果。
    Object.defineProperty(process, "exit", {
      value: this.devExit,
    });

    // 使用 microtask 模拟 spawn 返回后异步触发 server-ready，
    // 同时验证 Manager 必须在 spawn 之前完成事件订阅。
    queueMicrotask(() => {
      this.serverReadyListener?.(5173, this.previewUrl);
    });
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
