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

export type RepositoryIntent = {
  allowStage: boolean;
  allowUnstage: boolean;
  allowCommit: boolean;
  commitAuthor: {
    name: string;
    email: string;
  } | null;
};

export type RepositoryCapability = {
  storageKind: "database" | "browser_git";
  canRead: boolean;
  canWrite: boolean;
  canExecuteServerTools: boolean;
  /**
   * Git 写权限只从创建 Run 的原始用户消息中冻结。
   *
   * 旧 Run 没有该字段时一律按“没有 Git 写权限”处理，不能因为恢复到新版
   * 部署而悄然获得 stage、unstage 或 commit 能力。
   */
  repositoryIntent?: RepositoryIntent;
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
  // 大型项目会持续新增组件、样式、配置与测试。这里采用宽松的安全上限，
  // 防止正常的多文件开发被误判为异常；真正的死循环仍由 no-progress
  // 熔断、并发限制、成本限制和运行时间预算共同阻止。
  maxFileMutations: 512,
  maxClientResumes: 32,
  maxNoProgressRepeats: 2,
} as const;

// 空项目需要逐文件生成完整骨架，再依次完成 Preview、Browser Verify 和最终说明。
// 128 轮可以覆盖较长的编码、验证与修复链路；该值只用于新建 Run 或读取
// 缺失字段的旧数据，部署侧仍可通过 MAX_AGENT_MODEL_TURNS 收紧预算。
export const DEFAULT_MAX_AGENT_MODEL_TURNS = 128;
export const DEFAULT_MAX_AGENT_WALL_TIME_SECONDS = 1_800;

export type AgentRunUsage = {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  fileMutations: number;
  clientResumes: number;
  repairRounds: number;
  repeatedFailureCount: number;
  activeExecutionDurationMs: number;
  activeExecutionStartedAt: string | null;
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
  activeExecutionDurationMs: 0,
  activeExecutionStartedAt: null,
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
    maxModelTurns: positiveInteger(
      value.maxModelTurns,
      DEFAULT_MAX_AGENT_MODEL_TURNS,
    ),
    maxWallTimeSeconds: positiveInteger(
      value.maxWallTimeSeconds,
      DEFAULT_MAX_AGENT_WALL_TIME_SECONDS,
    ),
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
    activeExecutionDurationMs: nonnegativeInteger(
      value.activeExecutionDurationMs,
    ),
    activeExecutionStartedAt: nullableTimestampString(
      value.activeExecutionStartedAt,
    ),
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

function nullableTimestampString(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/**
 * Run 的 wall-time 预算只统计服务端 Agent 真正在运行的时间。
 *
 * awaiting_client_tool 期间可能包含浏览器未打开、用户离开页面或 WebContainer
 * 安装运行等客户端等待，这些时间不应消耗模型执行预算。usage 使用 JSONB，
 * 因此把累计值和当前片段起点一起持久化即可跨 Serverless 实例恢复。
 */
export function resumeAgentExecution(
  usage: AgentRunUsage,
  now: Date,
): AgentRunUsage {
  return usage.activeExecutionStartedAt
    ? usage
    : {
        ...usage,
        activeExecutionStartedAt: now.toISOString(),
      };
}

export function pauseAgentExecution(
  usage: AgentRunUsage,
  now: Date,
): AgentRunUsage {
  const segmentStartedAt = usage.activeExecutionStartedAt
    ? Date.parse(usage.activeExecutionStartedAt)
    : Number.NaN;
  const segmentDurationMs = Number.isFinite(segmentStartedAt)
    ? Math.max(0, now.getTime() - segmentStartedAt)
    : 0;

  return {
    ...usage,
    activeExecutionDurationMs:
      usage.activeExecutionDurationMs + segmentDurationMs,
    activeExecutionStartedAt: null,
  };
}

export function getActiveExecutionDurationMs(
  usage: AgentRunUsage,
  now: Date,
): number {
  const segmentStartedAt = usage.activeExecutionStartedAt
    ? Date.parse(usage.activeExecutionStartedAt)
    : Number.NaN;

  return (
    usage.activeExecutionDurationMs +
    (Number.isFinite(segmentStartedAt)
      ? Math.max(0, now.getTime() - segmentStartedAt)
      : 0)
  );
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
  /** 只记录附件 UUID，图片二进制始终留在私有对象存储中。 */
  attachmentIds?: string[];
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
  verificationRuns: VerificationRunRecord[];
  verificationSteps: VerificationStepRecord[];
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

export type VerificationRunRecord = {
  id: string;
  // 用数据库生成的单调序列表达验证事实顺序，避免 createdAt 同毫秒时
  // replay 记录被旧记录覆盖。
  seq: number;
  runId: string;
  toolCallId: string;
  projectId: string;
  ownerId: string;
  revision: number;
  status: "pending" | "running" | "passed" | "failed";
  source: "agent" | "replay";
  replayCount: number;
  smokeSteps: Array<Record<string, unknown>>;
  acceptedNetworkFailures: Array<Record<string, unknown>>;
  buildEvidence: Record<string, unknown> | null;
  runtimeEvidence: Record<string, unknown> | null;
  consoleEvidence: Record<string, unknown> | null;
  browserEvidence: Record<string, unknown> | null;
  networkEvidence: Record<string, unknown> | null;
  buildOk: boolean | null;
  runtimeOk: boolean | null;
  consoleOk: boolean | null;
  networkOk: boolean | null;
  actionsOk: boolean | null;
  assertionsOk: boolean | null;
  revisionOk: boolean | null;
  failedStep: number | null;
  summary: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type VerificationStepRecord = {
  id: string;
  verificationRunId: string;
  stepIndex: number;
  action: string;
  target: Record<string, unknown> | null;
  status: "passed" | "failed";
  startedAt: Date;
  durationMs: number;
  message: string;
  error: Record<string, unknown> | null;
};
