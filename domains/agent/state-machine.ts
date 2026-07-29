import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { AgentRunStatus } from "@/domains/agent/types";
import { TERMINAL_AGENT_RUN_STATUSES } from "@/domains/agent/types";

const LEGAL_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: [
    "awaiting_client_tool",
    "awaiting_async_job",
    "succeeded",
    "failed",
    "cancelled",
    "budget_exhausted",
    "conflicted",
  ],
  awaiting_client_tool: [
    "running",
    "failed",
    "cancelled",
    "budget_exhausted",
    "conflicted",
  ],
  awaiting_async_job: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  budget_exhausted: [],
  conflicted: [],
};

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_AGENT_RUN_STATUSES.includes(
    status as (typeof TERMINAL_AGENT_RUN_STATUSES)[number],
  );
}

/**
 * 状态迁移只在这一处声明。Store 与 Orchestrator 都调用同一个 reducer，
 * 避免 API、后台任务各自实现一套不一致的终态判断。
 */
export function reduceAgentRunStatus(
  current: AgentRunStatus,
  next: AgentRunStatus,
): AgentRunStatus {
  if (current === next) {
    return current;
  }

  if (!LEGAL_TRANSITIONS[current].includes(next)) {
    throw new AgentError(
      AGENT_ERROR_CODES.invalidTransition,
      `Agent Run 不能从 ${current} 迁移到 ${next}。`,
      409,
      { current, next },
    );
  }

  return next;
}
