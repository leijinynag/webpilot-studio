import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserGitClient } from "@/infrastructure/browser-git/client";

class SilentWorker {
  static instances: SilentWorker[] = [];

  readonly terminate = vi.fn();

  constructor() {
    SilentWorker.instances.push(this);
  }

  addEventListener() {
    // 本用例刻意模拟 Worker 既不响应、也不触发 error 的失联状态。
  }

  postMessage() {
    // 请求被接收但永不返回，用于覆盖浏览器中最容易形成无限 loading 的路径。
  }
}

describe("BrowserGitClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    SilentWorker.instances = [];
    vi.stubGlobal("Worker", SilentWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("terminates a silent Worker and rejects the pending request after timeout", async () => {
    const client = new BrowserGitClient();
    const initialization = client.initialize({
      projectId: crypto.randomUUID(),
      projectName: "Timeout recovery",
      initialFiles: [],
      allowCreate: true,
    });
    const rejection = expect(initialization).rejects.toThrow(
      "Browser Git initialize 操作超时",
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(SilentWorker.instances).toHaveLength(1);
    expect(SilentWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
});
