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
};

export type AgentRunUsage = {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
};

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
