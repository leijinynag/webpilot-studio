import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import {
  isTerminalAgentRunStatus,
  reduceAgentRunStatus,
} from "@/domains/agent/state-machine";
import type {
  AgentRunEvent,
  AgentRunRecord,
  AgentRunStatus,
  AgentConversationSnapshot,
  ConversationRecord,
  FrozenAgentRunProfile,
  ToolInvocationRecord,
  TranscriptMessage,
} from "@/domains/agent/types";
import {
  agentRunEvents,
  agentRuns,
  conversations,
  databaseSchema,
  projects,
  toolInvocations,
  transcriptMessages,
} from "@/infrastructure/db/schema";

type RelationalSchema = ExtractTablesWithRelations<typeof databaseSchema>;
type DatabaseLike<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  typeof databaseSchema,
  RelationalSchema
>;

const NON_TERMINAL_STATUSES = [
  "queued",
  "running",
  "awaiting_client_tool",
  "awaiting_async_job",
] as const satisfies readonly AgentRunStatus[];

export type CreateAgentRunInput = {
  ownerId: string;
  projectId: string;
  conversationId?: string;
  conversationTitle: string;
  userMessage: string;
  profile: FrozenAgentRunProfile;
};

type NewTranscriptMessage = TranscriptMessage extends infer Message
  ? Message extends TranscriptMessage
    ? Omit<Message, "id" | "seq" | "createdAt">
    : never
  : never;

export class AgentStore<TQueryResult extends PgQueryResultHKT> {
  constructor(private readonly db: DatabaseLike<TQueryResult>) {}

  /**
   * 用户消息、冻结配置、Run 与首个事件在同一事务内创建。
   * 只要创建接口返回 runId，后续刷新就一定能从数据库恢复完整起点。
   */
  async createRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [project] = await tx
          .select({
            id: projects.id,
            revision: projects.revision,
            storageKind: projects.storageKind,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, input.projectId),
              eq(projects.ownerId, input.ownerId),
              isNull(projects.deletedAt),
            ),
          );

        if (!project) {
          throw new AgentError(
            AGENT_ERROR_CODES.invalidRequest,
            "项目不存在或不属于当前匿名工作区。",
            404,
          );
        }

        if (
          project.storageKind !== input.profile.repositoryCapability.storageKind
        ) {
          throw new AgentError(
            AGENT_ERROR_CODES.invalidRequest,
            "冻结的 Repository capability 与项目存储类型不一致。",
            409,
          );
        }

        let conversationId = input.conversationId;

        if (conversationId) {
          const [conversation] = await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, conversationId),
                eq(conversations.ownerId, input.ownerId),
                eq(conversations.projectId, input.projectId),
                isNull(conversations.deletedAt),
              ),
            );

          if (!conversation) {
            throw new AgentError(
              AGENT_ERROR_CODES.invalidRequest,
              "Conversation 不存在或不属于当前项目。",
              404,
            );
          }

          // 复用会话时同步更新时间，列表页才能把刚刚活跃的会话排到前面。
          await tx
            .update(conversations)
            .set({ updatedAt: new Date() })
            .where(eq(conversations.id, conversationId));
        } else {
          const [conversation] = await tx
            .insert(conversations)
            .values({
              ownerId: input.ownerId,
              projectId: input.projectId,
              title: normalizeConversationTitle(input.conversationTitle),
            })
            .returning({ id: conversations.id });

          if (!conversation) {
            throw new Error("创建 Conversation 失败。");
          }

          conversationId = conversation.id;
        }

        const correlationId = randomUUID();
        const [run] = await tx
          .insert(agentRuns)
          .values({
            conversationId,
            projectId: input.projectId,
            ownerId: input.ownerId,
            status: "queued",
            startRevision: project.revision,
            currentRevision: project.revision,
            locale: input.profile.locale,
            provider: input.profile.provider,
            model: input.profile.model,
            promptProfile: input.profile.promptProfile,
            promptDigest: input.profile.promptDigest,
            toolsetProfile: input.profile.toolsetProfile,
            toolsetDigest: input.profile.toolsetDigest,
            modelProfile: input.profile.modelProfile,
            repositoryCapability: input.profile.repositoryCapability,
            budget: input.profile.budget,
            usage: {
              modelTurns: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
            correlationId,
          })
          .returning();

        if (!run) {
          throw new Error("创建 Agent Run 失败。");
        }

        await tx.insert(transcriptMessages).values({
          conversationId,
          runId: run.id,
          role: "user",
          kind: "user_message",
          payload: { content: normalizeUserMessage(input.userMessage) },
        });
        await tx.insert(agentRunEvents).values({
          runId: run.id,
          type: "run.created",
          payload: {
            status: run.status,
            startRevision: run.startRevision,
            correlationId,
          },
        });

        return toAgentRunRecord(run);
      });
    } catch (error) {
      // API 层的并发预检只能改善常见错误提示；跨实例同时插入时，
      // 最终仍由 partial unique index 决定胜者，并在这里转成稳定领域错误。
      if (isActiveProjectRunUniqueViolation(error)) {
        throw new AgentError(
          AGENT_ERROR_CODES.runConflict,
          "当前项目已有 Agent Run 正在执行。",
          409,
          { projectId: input.projectId },
        );
      }

      throw error;
    }
  }

  async getRun(input: {
    ownerId: string;
    runId: string;
  }): Promise<AgentRunRecord> {
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
        ),
      );

    if (!run) {
      throw new AgentError(
        AGENT_ERROR_CODES.runNotFound,
        "Agent Run 不存在或不属于当前匿名工作区。",
        404,
      );
    }

    return toAgentRunRecord(run);
  }

  async createConversation(input: {
    ownerId: string;
    projectId: string;
    title: string;
  }): Promise<ConversationRecord> {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, input.projectId),
          eq(projects.ownerId, input.ownerId),
          isNull(projects.deletedAt),
        ),
      );

    if (!project) {
      throw new AgentError(
        AGENT_ERROR_CODES.invalidRequest,
        "项目不存在或不属于当前匿名工作区。",
        404,
      );
    }

    const [conversation] = await this.db
      .insert(conversations)
      .values({
        ownerId: input.ownerId,
        projectId: input.projectId,
        title: normalizeConversationTitle(input.title),
      })
      .returning();

    if (!conversation) {
      throw new Error("创建 Conversation 失败。");
    }

    return toConversationRecord(conversation);
  }

  async listConversations(input: {
    ownerId: string;
    projectId: string;
  }): Promise<ConversationRecord[]> {
    const rows = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.ownerId, input.ownerId),
          eq(conversations.projectId, input.projectId),
          isNull(conversations.deletedAt),
        ),
      )
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt));

    return rows.map(toConversationRecord);
  }

  /**
   * 工作台刷新时一次性读取会话事实。客户端只把它当作投影，
   * 不在本地拼接 transcript、Run 或工具结果，避免 SSE 乱序造成脏状态。
   */
  async getConversationSnapshot(input: {
    ownerId: string;
    conversationId: string;
  }): Promise<AgentConversationSnapshot> {
    const [conversation] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.ownerId, input.ownerId),
          isNull(conversations.deletedAt),
        ),
      );

    if (!conversation) {
      throw new AgentError(
        AGENT_ERROR_CODES.runNotFound,
        "Conversation 不存在或不属于当前匿名工作区。",
        404,
      );
    }

    const [transcriptRows, runRows] = await Promise.all([
      this.db
        .select()
        .from(transcriptMessages)
        .where(eq(transcriptMessages.conversationId, input.conversationId))
        .orderBy(asc(transcriptMessages.seq)),
      this.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.conversationId, input.conversationId),
            eq(agentRuns.ownerId, input.ownerId),
          ),
        )
        .orderBy(asc(agentRuns.createdAt)),
    ]);

    const runIds = runRows.map((run) => run.id);
    const [eventRows, toolRows] = runIds.length
      ? await Promise.all([
          this.db
            .select()
            .from(agentRunEvents)
            .where(inArray(agentRunEvents.runId, runIds))
            .orderBy(asc(agentRunEvents.sequence)),
          this.db
            .select()
            .from(toolInvocations)
            .where(inArray(toolInvocations.runId, runIds))
            .orderBy(asc(toolInvocations.createdAt)),
        ])
      : [[], []];

    return {
      conversation: toConversationRecord(conversation),
      transcript: transcriptRows.map(toTranscriptMessage),
      runs: runRows.map(toAgentRunRecord),
      events: eventRows,
      tools: toolRows,
    };
  }

  async countActiveRuns(input: {
    ownerId?: string;
    projectId?: string;
  }): Promise<number> {
    const rows = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          input.ownerId ? eq(agentRuns.ownerId, input.ownerId) : undefined,
          input.projectId
            ? eq(agentRuns.projectId, input.projectId)
            : undefined,
          inArray(agentRuns.status, [...NON_TERMINAL_STATUSES]),
        ),
      );

    return rows.length;
  }

  async listRecoverableRuns(input: {
    ownerId: string;
    projectId?: string;
  }): Promise<AgentRunRecord[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.ownerId, input.ownerId),
          input.projectId
            ? eq(agentRuns.projectId, input.projectId)
            : undefined,
          inArray(agentRuns.status, [...NON_TERMINAL_STATUSES]),
        ),
      )
      .orderBy(asc(agentRuns.createdAt));

    return rows.map(toAgentRunRecord);
  }

  async listTranscript(input: {
    ownerId: string;
    conversationId: string;
  }): Promise<TranscriptMessage[]> {
    await this.assertOwnedConversation(input);

    const rows = await this.db
      .select()
      .from(transcriptMessages)
      .where(eq(transcriptMessages.conversationId, input.conversationId))
      .orderBy(asc(transcriptMessages.seq));

    return rows.map(toTranscriptMessage);
  }

  async appendTranscript(
    input: NewTranscriptMessage,
  ): Promise<TranscriptMessage> {
    const payload = transcriptToPayload(input);
    const [row] = await this.db
      .insert(transcriptMessages)
      .values({
        conversationId: input.conversationId,
        runId: input.runId ?? null,
        role: input.role,
        kind: input.kind,
        payload,
      })
      .returning();

    if (!row) {
      throw new Error("追加 Transcript 失败。");
    }

    return toTranscriptMessage(row);
  }

  async appendEvent(input: {
    runId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<AgentRunEvent> {
    const [row] = await this.db
      .insert(agentRunEvents)
      .values(input)
      .returning();

    if (!row) {
      throw new Error("追加 Agent Run 事件失败。");
    }

    return row;
  }

  async listEventsAfter(input: {
    ownerId: string;
    runId: string;
    cursor?: number;
  }): Promise<AgentRunEvent[]> {
    await this.getRun(input);
    const rows = await this.db
      .select()
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.runId, input.runId),
          input.cursor === undefined
            ? undefined
            : gt(agentRunEvents.sequence, input.cursor),
        ),
      )
      .orderBy(asc(agentRunEvents.sequence));

    return rows;
  }

  async transitionRun(input: {
    ownerId: string;
    runId: string;
    status: AgentRunStatus;
    currentRevision?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<AgentRunRecord> {
    const current = await this.getRun(input);
    const nextStatus = reduceAgentRunStatus(current.status, input.status);
    const now = new Date();
    const [updated] = await this.db
      .update(agentRuns)
      .set({
        status: nextStatus,
        currentRevision: input.currentRevision ?? current.currentRevision,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        startedAt:
          nextStatus === "running" && !current.startedAt
            ? now
            : current.startedAt,
        completedAt: isTerminalAgentRunStatus(nextStatus) ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
          eq(agentRuns.status, current.status),
        ),
      )
      .returning();

    if (!updated) {
      throw new AgentError(
        AGENT_ERROR_CODES.runConflict,
        "Agent Run 状态已被其他执行器更新。",
        409,
      );
    }

    await this.appendEvent({
      runId: input.runId,
      type: "run.status_changed",
      payload: {
        previousStatus: current.status,
        status: nextStatus,
        currentRevision: updated.currentRevision,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      },
    });

    return toAgentRunRecord(updated);
  }

  async requestCancellation(input: {
    ownerId: string;
    runId: string;
  }): Promise<AgentRunRecord> {
    const current = await this.getRun(input);

    if (isTerminalAgentRunStatus(current.status)) {
      return current;
    }

    const now = new Date();
    const [updated] = await this.db
      .update(agentRuns)
      .set({ cancellationRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
          isNull(agentRuns.cancellationRequestedAt),
        ),
      )
      .returning();

    const result = updated
      ? toAgentRunRecord(updated)
      : await this.getRun(input);

    if (updated) {
      await this.appendEvent({
        runId: input.runId,
        type: "run.cancellation_requested",
        payload: { requestedAt: now.toISOString() },
      });
    }

    return result;
  }

  async claimExecution(input: {
    ownerId: string;
    runId: string;
    leaseMilliseconds?: number;
  }): Promise<string | null> {
    const leaseId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (input.leaseMilliseconds ?? 180_000),
    );
    const [updated] = await this.db
      .update(agentRuns)
      .set({
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
          inArray(agentRuns.status, [...NON_TERMINAL_STATUSES]),
          or(
            isNull(agentRuns.executionLeaseId),
            isNull(agentRuns.executionLeaseExpiresAt),
            lt(agentRuns.executionLeaseExpiresAt, now),
          ),
        ),
      )
      .returning({ id: agentRuns.id });

    return updated ? leaseId : null;
  }

  async renewExecutionLease(input: {
    ownerId: string;
    runId: string;
    leaseId: string;
    leaseMilliseconds?: number;
  }): Promise<void> {
    const now = new Date();
    const [updated] = await this.db
      .update(agentRuns)
      .set({
        executionLeaseExpiresAt: new Date(
          now.getTime() + (input.leaseMilliseconds ?? 180_000),
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
          eq(agentRuns.executionLeaseId, input.leaseId),
          inArray(agentRuns.status, [...NON_TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: agentRuns.id });

    if (!updated) {
      throw new AgentError(
        AGENT_ERROR_CODES.runConflict,
        "Agent Run 执行租约已失效。",
        409,
      );
    }
  }

  async releaseExecutionLease(input: {
    ownerId: string;
    runId: string;
    leaseId: string;
  }): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
          eq(agentRuns.executionLeaseId, input.leaseId),
        ),
      );
  }

  async updateRunProgress(input: {
    ownerId: string;
    runId: string;
    currentRevision?: number;
    usage?: AgentRunRecord["usage"];
  }): Promise<AgentRunRecord> {
    const [updated] = await this.db
      .update(agentRuns)
      .set({
        ...(input.currentRevision === undefined
          ? {}
          : { currentRevision: input.currentRevision }),
        ...(input.usage ? { usage: input.usage } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.ownerId, input.ownerId),
          inArray(agentRuns.status, [...NON_TERMINAL_STATUSES]),
        ),
      )
      .returning();

    if (!updated) {
      throw new AgentError(
        AGENT_ERROR_CODES.runConflict,
        "Agent Run 已进入终态或被其他执行器更新。",
        409,
      );
    }

    return toAgentRunRecord(updated);
  }

  /**
   * Orchestrator 必须先调用本方法，再执行真实工具。唯一约束令重试请求
   * 只能拿到同一条 ledger，不会让迟到或重复的 Tool Call 再次修改项目。
   */
  async registerToolInvocation(input: {
    runId: string;
    toolCallId: string;
    toolName: string;
    executionDomain: "server" | "client" | "async_worker";
    argumentsJson: Record<string, unknown>;
    idempotencyKey: string;
    revisionBefore?: number;
  }): Promise<{ invocation: ToolInvocationRecord; created: boolean }> {
    const inserted = await this.db
      .insert(toolInvocations)
      .values({
        ...input,
        revisionBefore: input.revisionBefore,
        status: "created",
      })
      .onConflictDoNothing({
        target: [toolInvocations.runId, toolInvocations.toolCallId],
      })
      .returning();

    if (inserted[0]) {
      return { invocation: inserted[0], created: true };
    }

    const [existing] = await this.db
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.runId, input.runId),
          eq(toolInvocations.toolCallId, input.toolCallId),
        ),
      );

    if (!existing) {
      throw new Error("读取 Tool Invocation ledger 失败。");
    }

    return { invocation: existing, created: false };
  }

  async markToolInvocationRunning(input: {
    runId: string;
    toolCallId: string;
  }): Promise<ToolInvocationRecord> {
    const [updated] = await this.db
      .update(toolInvocations)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(toolInvocations.runId, input.runId),
          eq(toolInvocations.toolCallId, input.toolCallId),
          eq(toolInvocations.status, "created"),
        ),
      )
      .returning();

    if (!updated) {
      throw new AgentError(
        AGENT_ERROR_CODES.toolAlreadyExecuted,
        "Tool Invocation 已经开始或结束，不能重复执行。",
        409,
      );
    }

    return updated;
  }

  async completeToolInvocation(input: {
    runId: string;
    toolCallId: string;
    status: "succeeded" | "failed" | "cancelled";
    resultJson: Record<string, unknown>;
    revisionAfter?: number;
    errorCode?: string;
  }): Promise<ToolInvocationRecord> {
    const [updated] = await this.db
      .update(toolInvocations)
      .set({
        status: input.status,
        resultJson: input.resultJson,
        revisionAfter: input.revisionAfter,
        errorCode: input.errorCode,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(toolInvocations.runId, input.runId),
          eq(toolInvocations.toolCallId, input.toolCallId),
          eq(toolInvocations.status, "running"),
        ),
      )
      .returning();

    if (!updated) {
      throw new AgentError(
        AGENT_ERROR_CODES.toolAlreadyExecuted,
        "Tool Invocation 不在可完成状态。",
        409,
      );
    }

    return updated;
  }

  async findSuccessfulRead(input: {
    runId: string;
    path: string;
    revision: number;
  }): Promise<boolean> {
    const rows = await this.db
      .select({ argumentsJson: toolInvocations.argumentsJson })
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.runId, input.runId),
          eq(toolInvocations.toolName, "read_file"),
          eq(toolInvocations.status, "succeeded"),
          eq(toolInvocations.revisionBefore, input.revision),
        ),
      );

    return rows.some(
      (row) =>
        typeof row.argumentsJson.path === "string" &&
        row.argumentsJson.path === input.path,
    );
  }

  private async assertOwnedConversation(input: {
    ownerId: string;
    conversationId: string;
  }): Promise<void> {
    const [conversation] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.ownerId, input.ownerId),
          isNull(conversations.deletedAt),
        ),
      );

    if (!conversation) {
      throw new AgentError(
        AGENT_ERROR_CODES.runNotFound,
        "Conversation 不存在或不属于当前匿名工作区。",
        404,
      );
    }
  }
}

function normalizeConversationTitle(value: string): string {
  const title = value.trim();

  if (!title || title.length > 160) {
    throw new AgentError(
      AGENT_ERROR_CODES.invalidRequest,
      "Conversation 标题长度必须在 1 到 160 个字符之间。",
    );
  }

  return title;
}

function normalizeUserMessage(value: string): string {
  const message = value.trim();

  if (!message) {
    throw new AgentError(
      AGENT_ERROR_CODES.invalidRequest,
      "用户消息不能为空。",
    );
  }

  return message;
}

function isActiveProjectRunUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  // Neon、PGlite 与 Drizzle 对底层错误的包装层数不同，因此沿 cause 链检查。
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }

    const record = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const message = typeof record.message === "string" ? record.message : "";
    const constraint =
      typeof record.constraint === "string" ? record.constraint : "";

    if (
      record.code === "23505" &&
      (constraint === "agent_runs_project_active_uidx" ||
        message.includes("agent_runs_project_active_uidx"))
    ) {
      return true;
    }

    current = record.cause;
  }

  return false;
}

function transcriptToPayload(
  message: NewTranscriptMessage,
): Record<string, unknown> {
  switch (message.kind) {
    case "user_message":
    case "assistant_message":
      return { content: message.content };
    case "tool_call":
      return {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        argumentsJson: message.argumentsJson,
      };
    case "tool_result":
      return {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        resultJson: message.resultJson,
      };
    case "system_event":
      return { eventType: message.eventType, data: message.data };
  }
}

function toTranscriptMessage(
  row: typeof transcriptMessages.$inferSelect,
): TranscriptMessage {
  const base = {
    id: row.id,
    conversationId: row.conversationId,
    runId: row.runId,
    seq: row.seq,
    createdAt: row.createdAt,
  };
  const payload = row.payload;

  switch (row.kind) {
    case "user_message":
      return {
        ...base,
        kind: row.kind,
        role: "user",
        content: String(payload.content ?? ""),
      };
    case "assistant_message":
      return {
        ...base,
        kind: row.kind,
        role: "assistant",
        content: String(payload.content ?? ""),
      };
    case "tool_call":
      return {
        ...base,
        kind: row.kind,
        role: "assistant",
        toolCallId: String(payload.toolCallId ?? ""),
        toolName: String(payload.toolName ?? ""),
        argumentsJson: asRecord(payload.argumentsJson),
      };
    case "tool_result":
      return {
        ...base,
        kind: row.kind,
        role: "tool",
        toolCallId: String(payload.toolCallId ?? ""),
        toolName: String(payload.toolName ?? ""),
        resultJson: asRecord(payload.resultJson),
      };
    case "system_event":
      return {
        ...base,
        kind: row.kind,
        role: "system",
        eventType: String(payload.eventType ?? ""),
        data: asRecord(payload.data),
      };
  }
}

function toConversationRecord(
  row: typeof conversations.$inferSelect,
): ConversationRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    ownerId: row.ownerId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAgentRunRecord(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    ...row,
    locale: row.locale as AgentRunRecord["locale"],
    repositoryCapability:
      row.repositoryCapability as AgentRunRecord["repositoryCapability"],
    budget: row.budget as AgentRunRecord["budget"],
    usage: row.usage as AgentRunRecord["usage"],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
