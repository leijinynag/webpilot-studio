export const AGENT_ERROR_CODES = {
  invalidRequest: "AGENT_INVALID_REQUEST",
  runNotFound: "AGENT_RUN_NOT_FOUND",
  invalidTransition: "AGENT_INVALID_TRANSITION",
  runConflict: "AGENT_RUN_CONFLICT",
  providerNotConfigured: "AGENT_PROVIDER_NOT_CONFIGURED",
  providerTimeout: "AGENT_PROVIDER_TIMEOUT",
  providerRateLimited: "AGENT_PROVIDER_RATE_LIMITED",
  providerInvalidStream: "AGENT_PROVIDER_INVALID_STREAM",
  providerInterrupted: "AGENT_PROVIDER_INTERRUPTED",
  profileUnavailable: "AGENT_PROFILE_UNAVAILABLE",
  budgetExhausted: "AGENT_BUDGET_EXHAUSTED",
  noProgress: "AGENT_NO_PROGRESS",
  cancelled: "AGENT_CANCELLED",
  revisionConflict: "AGENT_REVISION_CONFLICT",
  toolInvalidArguments: "AGENT_TOOL_INVALID_ARGUMENTS",
  toolReadRequired: "AGENT_TOOL_READ_REQUIRED",
  toolAlreadyExecuted: "AGENT_TOOL_ALREADY_EXECUTED",
} as const;

export type AgentErrorCode =
  (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}

/**
 * Error 的 message、stack 等字段默认不可枚举，直接放进对象再交给日志器时
 * 往往只会显示成 `{}`。这里统一提取稳定字段，同时兼容 Neon/PostgreSQL
 * 驱动附带的 code、constraint 等诊断信息，避免线上只能看到“未知错误”。
 */
const MAX_SERIALIZED_ERROR_DEPTH = 3;
const MAX_SERIALIZED_QUERY_CHARACTERS = 4_000;
const MAX_SERIALIZED_PARAMS = 50;

export function serializeAgentError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }

  const databaseError = error as Error & {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
    detail?: unknown;
    params?: unknown;
    query?: unknown;
    severity?: unknown;
  };

  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(isAgentError(error)
      ? {
          agentCode: error.code,
          status: error.status,
          ...(error.details ? { details: error.details } : {}),
        }
      : {}),
    ...(typeof databaseError.code === "string"
      ? { databaseCode: databaseError.code }
      : {}),
    ...(typeof databaseError.severity === "string"
      ? { severity: databaseError.severity }
      : {}),
    ...(typeof databaseError.constraint === "string"
      ? { constraint: databaseError.constraint }
      : {}),
    ...(typeof databaseError.detail === "string"
      ? { detail: databaseError.detail }
      : {}),
    ...(typeof databaseError.query === "string"
      ? {
          query: databaseError.query.slice(
            0,
            MAX_SERIALIZED_QUERY_CHARACTERS,
          ),
        }
      : {}),
    ...(Array.isArray(databaseError.params)
      ? { params: databaseError.params.slice(0, MAX_SERIALIZED_PARAMS) }
      : {}),
    ...(databaseError.cause !== undefined &&
    depth < MAX_SERIALIZED_ERROR_DEPTH
      ? { cause: serializeAgentError(databaseError.cause, depth + 1) }
      : {}),
  };
}
