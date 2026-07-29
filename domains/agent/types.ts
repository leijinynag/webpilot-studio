export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_client_tool",
  "awaiting_async_job",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "conflicted",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const TERMINAL_AGENT_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "conflicted",
] as const satisfies readonly AgentRunStatus[];

export type AgentLocale = "zh-CN" | "en-US";

export type RepositoryCapability = {
  storageKind: "database" | "browser_git";
  canRead: boolean;
  canWrite: boolean;
  canExecuteServerTools: boolean;
};

export type AgentRunBudget = {
  maxModelTurns: number;
  maxWallTimeSeconds: number;
  maxOutputCharacters: number;
  maxToolResultCharacters: number;
  maxFileMutations: number;
  maxClientResumes: number;
  maxNoProgressRepeats: number;
};

export const DEFAULT_AGENT_RUN_ACTIVITY_LIMITS = {
  maxFileMutations: 8,
  maxClientResumes: 6,
  maxNoProgressRepeats: 2,
} as const;

export type AgentRunUsage = {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  fileMutations: number;
  clientResumes: number;
  repairRounds: number;
  repeatedFailureCount: number;
  firstPreviewAt: string | null;
  firstPreviewDurationMs: number | null;
  latestPreviewAt: string | null;
  latestVerificationRevision: number | null;
  latestVerificationOk: boolean | null;
  latestFailureFingerprint: string | null;
};

export const EMPTY_AGENT_RUN_USAGE: AgentRunUsage = {
  modelTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  fileMutations: 0,
  clientResumes: 0,
  repairRounds: 0,
  repeatedFailureCount: 0,
  firstPreviewAt: null,
  firstPreviewDurationMs: null,
  latestPreviewAt: null,
  latestVerificationRevision: null,
  latestVerificationOk: null,
  latestFailureFingerprint: null,
};

/**
 * budget/usage 使用 JSONB 保存，旧 Run 不会自动获得新增字段。读取时集中补齐
 * 默认值，既保持冻结配置可恢复，也避免每个调用点都处理 undefined。
 */
export function normalizeAgentRunBudget(
  value: Record<string, unknown>,
): AgentRunBudget {
  return {
    maxModelTurns: positiveInteger(value.maxModelTurns, 12),
    maxWallTimeSeconds: positiveInteger(value.maxWallTimeSeconds, 300),
    maxOutputCharacters: positiveInteger(value.maxOutputCharacters, 24_000),
    maxToolResultCharacters: positiveInteger(
      value.maxToolResultCharacters,
      20_000,
    ),
    maxFileMutations: positiveInteger(
      value.maxFileMutations,
      DEFAULT_AGENT_RUN_ACTIVITY_LIMITS.maxFileMutations,
    ),
    maxClientResumes: positiveInteger(
      value.maxClientResumes,
      DEFAULT_AGENT_RUN_ACTIVITY_LIMITS.maxClientResumes,
    ),
    maxNoProgressRepeats: positiveInteger(
      value.maxNoProgressRepeats,
      DEFAULT_AGENT_RUN_ACTIVITY_LIMITS.maxNoProgressRepeats,
    ),
  };
}

export function normalizeAgentRunUsage(
  value: Record<string, unknown>,
): AgentRunUsage {
  return {
    modelTurns: nonnegativeInteger(value.modelTurns),
    inputTokens: nonnegativeInteger(value.inputTokens),
    outputTokens: nonnegativeInteger(value.outputTokens),
    fileMutations: nonnegativeInteger(value.fileMutations),
    clientResumes: nonnegativeInteger(value.clientResumes),
    repairRounds: nonnegativeInteger(value.repairRounds),
    repeatedFailureCount: nonnegativeInteger(value.repeatedFailureCount),
    firstPreviewAt: nullableString(value.firstPreviewAt),
    firstPreviewDurationMs: nullableNonnegativeInteger(
      value.firstPreviewDurationMs,
    ),
    latestPreviewAt: nullableString(value.latestPreviewAt),
    latestVerificationRevision: nullableNonnegativeInteger(
      value.latestVerificationRevision,
    ),
    latestVerificationOk:
      typeof value.latestVerificationOk === "boolean"
        ? value.latestVerificationOk
        : null,
    latestFailureFingerprint: nullableString(value.latestFailureFingerprint),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export type FrozenAgentRunProfile = {
  locale: AgentLocale;
  provider: string;
  model: string;
  promptProfile: string;
  promptDigest: string;
  toolsetProfile: string;
  toolsetDigest: string;
  modelProfile: string;
  repositoryCapability: RepositoryCapability;
  budget: AgentRunBudget;
};

type TranscriptBase = {
  id?: string;
  runId?: string | null;
  conversationId: string;
  seq?: number;
  createdAt?: Date;
};

export type UserMessage = TranscriptBase & {
  kind: "user_message";
  role: "user";
  content: string;
};

export type AssistantMessage = TranscriptBase & {
  kind: "assistant_message";
  role: "assistant";
  content: string;
};

export type ToolCallMessage = TranscriptBase & {
  kind: "tool_call";
  role: "assistant";
  toolCallId: string;
  toolName: string;
  argumentsJson: Record<string, unknown>;
};

export type ToolResultMessage = TranscriptBase & {
  kind: "tool_result";
  role: "tool";
  toolCallId: string;
  toolName: string;
  resultJson: Record<string, unknown>;
};

export type SystemEventMessage = TranscriptBase & {
  kind: "system_event";
  role: "system";
  eventType: string;
  data: Record<string, unknown>;
};

export type TranscriptMessage =
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ToolResultMessage
  | SystemEventMessage;

export type ProviderMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: Array<{
        id: string;
        name: string;
        argumentsJson: string;
      }>;
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
    };

export type AgentRunRecord = FrozenAgentRunProfile & {
  id: string;
  conversationId: string;
  projectId: string;
  ownerId: string;
  status: AgentRunStatus;
  startRevision: number;
  currentRevision: number;
  usage: AgentRunUsage;
  correlationId: string;
  executionLeaseId: string | null;
  executionLeaseExpiresAt: Date | null;
  cancellationRequestedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export type AgentRunEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type ConversationRecord = {
  id: string;
  projectId: string;
  ownerId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentConversationSnapshot = {
  conversation: ConversationRecord;
  transcript: TranscriptMessage[];
  runs: AgentRunRecord[];
  events: AgentRunEvent[];
  tools: ToolInvocationRecord[];
};

export type ToolInvocationRecord = {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  executionDomain: "server" | "client" | "async_worker";
  status: "created" | "running" | "succeeded" | "failed" | "cancelled";
  argumentsJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  idempotencyKey: string;
  revisionBefore: number | null;
  revisionAfter: number | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
};
