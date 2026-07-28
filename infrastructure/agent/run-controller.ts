const globalControllers = globalThis as typeof globalThis & {
  webpilotAgentRunControllers?: Map<string, AbortController>;
};

const controllers =
  globalControllers.webpilotAgentRunControllers ??
  new Map<string, AbortController>();

if (process.env.NODE_ENV !== "production") {
  globalControllers.webpilotAgentRunControllers = controllers;
}

/**
 * 这里只负责中止当前实例内的 fetch stream。跨实例取消依赖数据库中的
 * cancellation fence，因此内存 Controller 从来不是取消状态的事实来源。
 */
export async function withAgentRunController<T>(
  runId: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const existing = controllers.get(runId);

  if (existing) {
    // GET 恢复与 POST 创建可能在同一实例重复调度同一 Run。复用 signal，
    // 让数据库租约拒绝重复执行，而不是误把第一条仍健康的模型流中止。
    return operation(existing.signal);
  }

  const controller = new AbortController();
  controllers.set(runId, controller);

  try {
    return await operation(controller.signal);
  } finally {
    if (controllers.get(runId) === controller) {
      controllers.delete(runId);
    }
  }
}

export function abortAgentRun(runId: string): boolean {
  const controller = controllers.get(runId);

  if (!controller) {
    return false;
  }

  controller.abort();
  return true;
}
