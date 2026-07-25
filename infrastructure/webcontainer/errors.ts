import type {
  WebContainerDiagnostic,
  WebContainerErrorCode,
} from "@/infrastructure/webcontainer/lifecycle";

/**
 * 运行时错误同时保留两层信息：
 * - diagnostic 提供给 UI、测试和未来遥测使用，字段稳定且可序列化；
 * - Error.cause 保留底层 SDK/npm 异常，便于开发阶段继续追查原始堆栈。
 */
export class WebContainerRuntimeError extends Error {
  readonly diagnostic: WebContainerDiagnostic;

  constructor(
    code: WebContainerErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "WebContainerRuntimeError";
    this.diagnostic = {
      code,
      message,
      detail: options?.detail,
    };
  }
}

// catch 的值是 unknown，只提取适合直接展示的简短文本；
// 对象和其他复杂值不强行 stringify，避免产生 [object Object] 或泄露无关数据。
export function getErrorDetail(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : undefined;
}
