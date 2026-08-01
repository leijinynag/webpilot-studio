"use client";

import { deserializeBrowserGitError } from "@/infrastructure/browser-git/errors";
import type {
  BrowserGitRepositoryState,
  BrowserGitWorkerOperation,
  BrowserGitWorkerPayloadMap,
  BrowserGitWorkerRequest,
  BrowserGitWorkerResponse,
  BrowserGitWorkerResult,
} from "@/infrastructure/browser-git/protocol";

type PendingRequest = {
  resolve(value: BrowserGitWorkerResult): void;
  reject(error: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
};

const WORKER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Client 持有 Worker 生命周期与 pending request 表。
 * Worker 异常退出时，所有在途请求会明确失败；下一次调用会创建新 Worker，
 * 再由 LightningFS 使用相同 projectId 打开原 IndexedDB 仓库。
 */
export class BrowserGitClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  async initialize(input: {
    projectId: string;
    projectName: string;
    initialFiles: { path: string; content: string }[];
    allowCreate: boolean;
  }) {
    const result = await this.request(input.projectId, "initialize", {
      projectId: input.projectId,
      projectName: input.projectName,
      initialFiles: input.initialFiles,
      allowCreate: input.allowCreate,
    });
    return result.data as BrowserGitRepositoryState;
  }

  async getState(projectId: string) {
    const result = await this.request(projectId, "state", {});
    return result.data as BrowserGitRepositoryState;
  }

  async listFiles(projectId: string) {
    const result = await this.request(projectId, "list_files", {});
    return result.data;
  }

  async readFile(projectId: string, path: string) {
    return (await this.request(projectId, "read_file", { path })).data;
  }

  async searchText(
    projectId: string,
    input: BrowserGitWorkerPayloadMap["search_text"],
  ) {
    return (await this.request(projectId, "search_text", input)).data;
  }

  async writeFile(
    projectId: string,
    input: BrowserGitWorkerPayloadMap["write_file"],
  ) {
    return (await this.request(projectId, "write_file", input)).data;
  }

  async deleteFile(
    projectId: string,
    input: BrowserGitWorkerPayloadMap["delete_file"],
  ) {
    return (await this.request(projectId, "delete_file", input)).data;
  }

  async renameFile(
    projectId: string,
    input: BrowserGitWorkerPayloadMap["rename_file"],
  ) {
    return (await this.request(projectId, "rename_file", input)).data;
  }

  async stage(projectId: string, paths: string[]) {
    return (
      await this.request(projectId, "stage", {
        paths,
      })
    ).data as BrowserGitRepositoryState;
  }

  async unstage(projectId: string, paths: string[]) {
    return (
      await this.request(projectId, "unstage", {
        paths,
      })
    ).data as BrowserGitRepositoryState;
  }

  async commit(projectId: string, input: BrowserGitWorkerPayloadMap["commit"]) {
    return (await this.request(projectId, "commit", input)).data as {
      oid: string;
      state: BrowserGitRepositoryState;
    };
  }

  async export(projectId: string) {
    return (await this.request(projectId, "export", {})).data as {
      archive: string;
      fileCount: number;
    };
  }

  async createCheckpoint(
    projectId: string,
    input: BrowserGitWorkerPayloadMap["create_checkpoint"],
  ) {
    return (await this.request(projectId, "create_checkpoint", input)).data;
  }

  async restoreCheckpoint(
    projectId: string,
    input: BrowserGitWorkerPayloadMap["restore_checkpoint"],
  ) {
    return (await this.request(projectId, "restore_checkpoint", input)).data;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.rejectPending(new Error("Browser Git Client 已关闭。"));
  }

  private request<TOperation extends BrowserGitWorkerOperation>(
    projectId: string,
    operation: TOperation,
    payload: BrowserGitWorkerPayloadMap[TOperation],
  ): Promise<BrowserGitWorkerResult> {
    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();
    const request: BrowserGitWorkerRequest<TOperation> = {
      protocol: "webpilot.browser-git.v1",
      type: "request",
      requestId,
      projectId,
      operation,
      payload,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(requestId)) {
          return;
        }

        // Worker 若内部任务永久 pending，通常不会触发 error 事件。
        // 超时后主动终止当前实例，避免串行队列继续阻塞后续操作；
        // 下一次请求会使用相同 projectId 从 IndexedDB 恢复仓库。
        this.worker?.terminate();
        this.worker = null;
        const timeoutError = new Error(
          `Browser Git ${operation} 操作超时，请重试。仓库数据仍保存在当前浏览器中。`,
        );
        reject(timeoutError);
        this.rejectPending(timeoutError);
      }, WORKER_REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timeout });
      worker.postMessage(request);
    });
  }

  private ensureWorker() {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "webpilot-browser-git",
    });
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleWorkerError);
    worker.addEventListener("messageerror", this.handleWorkerError);
    this.worker = worker;
    return worker;
  }

  private readonly handleMessage = (
    event: MessageEvent<BrowserGitWorkerResponse>,
  ) => {
    const response = event.data;
    const pending = this.pending.get(response.requestId);

    if (response.protocol !== "webpilot.browser-git.v1" || !pending) {
      return;
    }

    this.pending.delete(response.requestId);
    clearTimeout(pending.timeout);
    if (response.type === "error") {
      pending.reject(deserializeBrowserGitError(response.error));
      return;
    }
    pending.resolve(response);
  };

  private readonly handleWorkerError = () => {
    this.worker?.terminate();
    this.worker = null;
    this.rejectPending(
      new Error(
        "Browser Git Worker 已中断。下次操作会从 IndexedDB 重新打开仓库。",
      ),
    );
  };

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

let sharedClient: BrowserGitClient | null = null;

export function getBrowserGitClient() {
  sharedClient ??= new BrowserGitClient();
  return sharedClient;
}
