/// <reference lib="webworker" />

import {
  BrowserGitRuntime,
  BrowserGitWorkerDomainError,
} from "@/infrastructure/browser-git/runtime";
import type {
  BrowserGitWorkerError,
  BrowserGitWorkerOperation,
  BrowserGitWorkerRequest,
  BrowserGitWorkerResponse,
} from "@/infrastructure/browser-git/protocol";

const scope = self as DedicatedWorkerGlobalScope;
const runtimes = new Map<string, BrowserGitRuntime>();
let requestQueue = Promise.resolve();

/**
 * 所有请求都进入同一串行队列。读操作因此也能观察到前一个 mutation
 * 已经 flush 后的确定状态，不会出现 UI 刷新抢在 stage/write 完成之前读取旧 index。
 */
scope.addEventListener("message", (event: MessageEvent<unknown>) => {
  requestQueue = requestQueue
    .then(() => handleMessage(event.data))
    .catch((error) => {
      // 单个请求已经在 handleMessage 内转换错误；这里只阻止队列进入永久 rejected。
      console.error("[browser-git-worker]", error);
    });
});

async function handleMessage(input: unknown) {
  const request = parseRequest(input);

  if (!request) {
    return;
  }

  const runtime =
    runtimes.get(request.projectId) ?? new BrowserGitRuntime(request.projectId);
  runtimes.set(request.projectId, runtime);

  try {
    const data = await runtime.execute(request);
    const revision = await runtime.getRevision();
    const response: BrowserGitWorkerResponse = {
      protocol: "webpilot.browser-git.v1",
      type: "result",
      requestId: request.requestId,
      projectId: request.projectId,
      operation: request.operation,
      revision,
      data,
    };
    scope.postMessage(response);
  } catch (error) {
    scope.postMessage(toErrorResponse(request, error));
  }
}

function parseRequest(input: unknown): BrowserGitWorkerRequest | null {
  if (
    typeof input !== "object" ||
    input === null ||
    !("protocol" in input) ||
    input.protocol !== "webpilot.browser-git.v1" ||
    !("type" in input) ||
    input.type !== "request" ||
    !("requestId" in input) ||
    typeof input.requestId !== "string" ||
    !("projectId" in input) ||
    typeof input.projectId !== "string" ||
    !("operation" in input) ||
    !isOperation(input.operation) ||
    !("payload" in input) ||
    typeof input.payload !== "object" ||
    input.payload === null
  ) {
    return null;
  }

  return input as BrowserGitWorkerRequest;
}

function isOperation(value: unknown): value is BrowserGitWorkerOperation {
  return (
    typeof value === "string" &&
    [
      "initialize",
      "state",
      "list_files",
      "read_file",
      "search_text",
      "write_file",
      "delete_file",
      "rename_file",
      "stage",
      "unstage",
      "commit",
      "export",
      "create_checkpoint",
      "restore_checkpoint",
    ].includes(value)
  );
}

function toErrorResponse(
  request: BrowserGitWorkerRequest,
  error: unknown,
): BrowserGitWorkerError {
  const domainError =
    error instanceof BrowserGitWorkerDomainError ? error : null;

  return {
    protocol: "webpilot.browser-git.v1",
    type: "error",
    requestId: request.requestId,
    projectId: request.projectId,
    operation: request.operation,
    error: {
      code: (domainError?.code ??
        "WORKER_UNAVAILABLE") as BrowserGitWorkerError["error"]["code"],
      message:
        domainError?.message ??
        (error instanceof Error
          ? error.message
          : "Browser Git Worker 执行失败。"),
      ...(domainError?.details ? { details: domainError.details } : {}),
    },
  };
}
