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
