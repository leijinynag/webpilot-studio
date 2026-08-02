import type { Locale } from "@/infrastructure/i18n/locale";

const errorMessages = {
  zh: {
    INVALID_REQUEST: "请求参数不合法。",
    INTERNAL_ERROR: "服务暂时不可用，请稍后重试。",
    PROJECT_NOT_FOUND: "找不到这个项目。",
    PROJECT_DELETED: "这个项目已经被删除。",
    FILE_NOT_FOUND: "找不到请求的文件。",
    PROJECT_REVISION_CONFLICT: "Repository 已有更新，请刷新后重试。",
    STORAGE_KIND_UNAVAILABLE: "项目存储暂不可用，请稍后重试。",
    AGENT_INVALID_REQUEST: "Agent 请求不合法。",
    AGENT_RUN_NOT_FOUND: "找不到这次 Agent Run。",
    AGENT_RUN_CONFLICT: "当前已有 Agent Run 正在执行。",
    AGENT_PROVIDER_NOT_CONFIGURED: "模型服务尚未配置，请联系管理员。",
    AGENT_PROVIDER_TIMEOUT: "模型响应超时，请稍后重试。",
    AGENT_PROVIDER_RATE_LIMITED: "模型服务暂时繁忙，请稍后重试。",
    AGENT_CANCELLED: "Agent Run 已停止。",
    AGENT_BUDGET_EXHAUSTED: "本次任务已达到预算上限。",
    SHOWCASE_NOT_FOUND: "找不到这个 Showcase 案例。",
    SHOWCASE_STORAGE_UNAVAILABLE: "Showcase 存储暂不可用，请稍后重试。",
    SHOWCASE_ADMIN_UNAUTHORIZED: "没有 Showcase 管理权限。",
    SHOWCASE_RUNTIME_ONLY: "该部署仅提供 Showcase Runtime。",
  },
  en: {
    INVALID_REQUEST: "The request is invalid.",
    INTERNAL_ERROR: "The service is temporarily unavailable. Try again.",
    PROJECT_NOT_FOUND: "This project could not be found.",
    PROJECT_DELETED: "This project has been deleted.",
    FILE_NOT_FOUND: "The requested file could not be found.",
    PROJECT_REVISION_CONFLICT:
      "The Repository changed. Refresh and try again.",
    STORAGE_KIND_UNAVAILABLE:
      "Project storage is temporarily unavailable. Try again.",
    AGENT_INVALID_REQUEST: "The Agent request is invalid.",
    AGENT_RUN_NOT_FOUND: "This Agent Run could not be found.",
    AGENT_RUN_CONFLICT: "Another Agent Run is already in progress.",
    AGENT_PROVIDER_NOT_CONFIGURED:
      "The model provider is not configured. Contact an administrator.",
    AGENT_PROVIDER_TIMEOUT: "The model timed out. Try again.",
    AGENT_PROVIDER_RATE_LIMITED:
      "The model provider is busy. Try again shortly.",
    AGENT_CANCELLED: "The Agent Run was stopped.",
    AGENT_BUDGET_EXHAUSTED: "This task reached its budget limit.",
    SHOWCASE_NOT_FOUND: "This Showcase case could not be found.",
    SHOWCASE_STORAGE_UNAVAILABLE:
      "Showcase storage is temporarily unavailable. Try again.",
    SHOWCASE_ADMIN_UNAUTHORIZED: "Showcase administrator access is required.",
    SHOWCASE_RUNTIME_ONLY: "This deployment only provides Showcase Runtime.",
  },
} as const;

export function getLocalizedErrorMessage(
  code: string | undefined,
  locale: Locale,
  fallback?: string,
): string {
  if (!code) {
    return fallback ?? errorMessages[locale].INTERNAL_ERROR;
  }
  return (
    errorMessages[locale][code as keyof (typeof errorMessages)[Locale]] ??
    fallback ??
    errorMessages[locale].INTERNAL_ERROR
  );
}

export function getErrorMessageMap(locale: Locale) {
  return errorMessages[locale];
}
