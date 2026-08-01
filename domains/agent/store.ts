import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import type {
  PgQueryResultHKT,
  PgTransactionConfig,
} from "drizzle-orm/pg-core/session";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

import {
  BROWSER_VERIFY_TOOL_NAME,
  type BrowserVerifyToolArguments,
  browserVerifyToolArgumentsSchema,
  type BrowserVerifyResult,
  type ClientToolResultRequest,
} from "@/domains/agent/client-tools";
import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import {
  RUN_PREVIEW_TOOL_NAME,
  type RunPreviewToolArguments,
} from "@/domains/agent/evidence";
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
  VerificationRunRecord,
} from "@/domains/agent/types";
import {
  EMPTY_AGENT_RUN_USAGE,
  normalizeAgentRunBudget,
  normalizeAgentRunUsage,
  pauseAgentExecution,
  resumeAgentExecution,
} from "@/domains/agent/types";
import {
  deriveVerificationFailure,
  evaluateBrowserVerification,
} from "@/domains/agent/verification";
import {
  completeSuccessfulAgentRun,
  insertAgentStartCheckpoint,
} from "@/domains/project/history";
import {
  agentEvidence,
  agentRunEvents,
  agentRuns,
  conversations,
  databaseSchema,
  projects,
  toolInvocations,
  transcriptMessages,
  verificationRuns,
  verificationSteps,
} from "@/infrastructure/db/schema";

type RelationalSchema = ExtractTablesWithRelations<typeof databaseSchema>;
type DatabaseLike<TQueryResult extends PgQueryResultHKT> = PgDatabase<
  TQueryResult,
  typeof databaseSchema,
  RelationalSchema
>;
type DatabaseTransaction<TQueryResult extends PgQueryResultHKT> = PgTransaction<
  TQueryResult,
  typeof databaseSchema,
  RelationalSchema
>;
export type AgentTransactionRunner<
  TQueryResult extends PgQueryResultHKT,
> = <T>(
  operation: (transaction: DatabaseTransaction<TQueryResult>) => Promise<T>,
  config?: PgTransactionConfig,
) => Promise<T>;

const NON_TERMINAL_STATUSES = [
  "queued",
  "running",
  "awaiting_client_tool",
  "awaiting_async_job",
] as const satisfies readonly AgentRunStatus[];

/**
 * 只有这些状态允许服务端 Orchestrator 抢占执行租约。
 * awaiting_client_tool 的推进权属于浏览器结果事务；若服务端抢占它，会在
 * tool_result 落库前把 Run 暂时暴露为 running，形成不完整 Provider 消息链。
 */
const SERVER_EXECUTABLE_STATUSES = [
  "queued",
  "running",
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
  constructor(
    private readonly db: DatabaseLike<TQueryResult>,
    private readonly options: {
      transaction?: AgentTransactionRunner<TQueryResult>;
    } = {},
  ) {}

  /**
   * 所有需要原子性的 Agent 写入与一致性快照都从这一入口进入。
   *
   * PGlite 测试默认使用数据库自身事务；Neon 生产环境则注入固定 PoolClient 的
   * runner，避免热更新导致 Drizzle 把同一事务的 SQL 分配到不同连接。
   */
  private runTransaction<T>(
    operation: (
      transaction: DatabaseTransaction<TQueryResult>,
    ) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    return this.options.transaction
      ? this.options.transaction(operation, config)
      : this.db.transaction(operation, config);
  }

  /**
   * 用户消息、冻结配置、Run 与首个事件在同一事务内创建。
   * 只要创建接口返回 runId，后续刷新就一定能从数据库恢复完整起点。
   */
  async createRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    try {
      return await this.runTransaction(async (tx) => {
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
              ...EMPTY_AGENT_RUN_USAGE,
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
        await insertAgentStartCheckpoint(tx, {
          projectId: run.projectId,
          runId: run.id,
          revision: run.startRevision,
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
   * 工作台默认恢复仍有推进价值的会话，而不是机械选择最近创建的空会话。
   * 一个 awaiting_client_tool Run 可能正在等待浏览器接管 run_preview；
   * 若刷新后被更新更晚的空会话遮住，客户端就收不到 Tool Ledger 中的等待项，
   * 用户看到的便会是“代码已经写完，但预览一直没有开始”的错误状态。
   *
   * 显式 conversationId 不经过这里，用户主动切换历史会话始终拥有最高优先级。
   */
  async findActiveConversationId(input: {
    ownerId: string;
    projectId: string;
  }): Promise<string | null> {
    const [row] = await this.db
      .select({ conversationId: agentRuns.conversationId })
      .from(agentRuns)
      .innerJoin(
        conversations,
        and(
          eq(conversations.id, agentRuns.conversationId),
          eq(conversations.ownerId, input.ownerId),
          eq(conversations.projectId, input.projectId),
          isNull(conversations.deletedAt),
        ),
      )
      .where(
        and(
          eq(agentRuns.ownerId, input.ownerId),
          eq(agentRuns.projectId, input.projectId),
          inArray(agentRuns.status, [...NON_TERMINAL_STATUSES]),
        ),
      )
      .orderBy(desc(agentRuns.updatedAt), desc(agentRuns.createdAt))
      .limit(1);

    return row?.conversationId ?? null;
  }

  /**
   * 工作台刷新时一次性读取会话事实。客户端只把它当作投影，
   * 不在本地拼接 transcript、Run 或工具结果，避免 SSE 乱序造成脏状态。
   */
  async getConversationSnapshot(input: {
    ownerId: string;
    conversationId: string;
  }): Promise<AgentConversationSnapshot> {
    // 聚合快照包含 Conversation、Run、事件、Tool Ledger 与验证记录。所有读取
    // 必须共享同一个 PostgreSQL MVCC snapshot，否则可能拼出“旧 running Run +
    // 新 succeeded 事件”的不可能状态，并让刷新后的 UI 永久停在执行中。
    //
    // 生产环境注入的 runner 会显式固定 Neon PoolClient，避免 Turbopack 多模块
    // 实例下 Drizzle 的 Pool 身份判断失效。数据库测试不注入 runner，继续使用
    // PGlite 自身的事务实现，领域层因此不依赖具体数据库驱动。
    return this.runTransaction(async (tx) => {
        const [conversation] = await tx
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
          tx
            .select()
            .from(transcriptMessages)
            .where(eq(transcriptMessages.conversationId, input.conversationId))
            .orderBy(asc(transcriptMessages.seq)),
          tx
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
        const [eventRows, toolRows, verificationRunRows] = runIds.length
          ? await Promise.all([
              tx
                .select()
                .from(agentRunEvents)
                .where(inArray(agentRunEvents.runId, runIds))
                .orderBy(asc(agentRunEvents.sequence)),
              tx
                .select()
                .from(toolInvocations)
                .where(inArray(toolInvocations.runId, runIds))
                .orderBy(asc(toolInvocations.createdAt)),
              tx
                .select()
                .from(verificationRuns)
                .where(inArray(verificationRuns.runId, runIds))
                .orderBy(asc(verificationRuns.createdAt)),
            ])
          : [[], [], []];
        const verificationRunIds = verificationRunRows.map((run) => run.id);
        const verificationStepRows = verificationRunIds.length
          ? await tx
              .select()
              .from(verificationSteps)
              .where(
                inArray(
                  verificationSteps.verificationRunId,
                  verificationRunIds,
                ),
              )
              .orderBy(
                asc(verificationSteps.verificationRunId),
                asc(verificationSteps.stepIndex),
              )
          : [];

        return {
          conversation: toConversationRecord(conversation),
          transcript: transcriptRows.map(toTranscriptMessage),
          runs: runRows.map(toAgentRunRecord),
          events: eventRows,
          tools: toolRows,
          verificationRuns: verificationRunRows.map(toVerificationRunRecord),
          verificationSteps: verificationStepRows,
        };
      }, {
        isolationLevel: "repeatable read",
      });
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
    const nextUsage =
      nextStatus === "running"
        ? resumeAgentExecution(current.usage, now)
        : current.status === "running"
          ? pauseAgentExecution(current.usage, now)
          : current.usage;
    const [updated] = await this.db
      .update(agentRuns)
      .set({
        status: nextStatus,
        currentRevision: input.currentRevision ?? current.currentRevision,
        usage: nextUsage,
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

  async completeSuccessfulRun(input: {
    ownerId: string;
    runId: string;
  }): Promise<AgentRunRecord> {
    const row = await this.runTransaction((tx) =>
      completeSuccessfulAgentRun(tx, input),
    );

    return toAgentRunRecord(row);
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
          inArray(agentRuns.status, [...SERVER_EXECUTABLE_STATUSES]),
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

  /**
   * 修复历史竞态留下的 running 脏状态。
   *
   * 正常客户端工具挂起会原子写入 running Ledger，并把 Run 切到
   * awaiting_client_tool。若旧执行路径曾在结果回传前错误抢占 Run，本方法会在
   * Provider 调用前识别“最后一条 Transcript 是尚未完成的客户端 tool_call”，
   * 再通过租约 CAS 把等待权交还浏览器。这里不补写 tool_result，因为工具尚未
   * 真正完成，持久化 Ledger 才是客户端恢复请求的事实来源。
   */
  async recoverPendingClientToolWait(input: {
    ownerId: string;
    runId: string;
    leaseId: string;
  }): Promise<boolean> {
    return this.runTransaction(async (tx) => {
      const [runRow] = await tx
        .select({
          id: agentRuns.id,
          conversationId: agentRuns.conversationId,
          status: agentRuns.status,
          currentRevision: agentRuns.currentRevision,
          executionLeaseId: agentRuns.executionLeaseId,
          usage: agentRuns.usage,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
          ),
        );

      if (
        !runRow ||
        runRow.status !== "running" ||
        runRow.executionLeaseId !== input.leaseId
      ) {
        return false;
      }

      const pendingInvocations = await tx
        .select({
          toolCallId: toolInvocations.toolCallId,
          toolName: toolInvocations.toolName,
        })
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.runId, input.runId),
            eq(toolInvocations.executionDomain, "client"),
            eq(toolInvocations.status, "running"),
          ),
        )
        .orderBy(desc(toolInvocations.createdAt))
        .limit(2);

      // 同一 Run 正常只允许等待一个客户端工具。多条 running Ledger 表示更深层
      // 的一致性损坏，不能猜测应恢复哪一条，留给显式诊断处理。
      if (pendingInvocations.length !== 1) {
        return false;
      }

      const pendingInvocation = pendingInvocations[0];
      const [latestTranscriptRow] = await tx
        .select({
          kind: transcriptMessages.kind,
          payload: transcriptMessages.payload,
        })
        .from(transcriptMessages)
        .where(
          and(
            eq(transcriptMessages.conversationId, runRow.conversationId),
            eq(transcriptMessages.runId, input.runId),
          ),
        )
        .orderBy(desc(transcriptMessages.seq))
        .limit(1);

      const latestToolCallId =
        latestTranscriptRow?.kind === "tool_call"
          ? String(latestTranscriptRow.payload.toolCallId ?? "")
          : null;
      const isReplayInvocation =
        pendingInvocation.toolCallId.startsWith("replay:");

      // 自动 replay 不会制造 assistant tool_call；除此之外必须要求 Transcript
      // 最后一项与 Ledger 精确匹配，避免把普通 running Run 误判为等待态。
      if (
        !isReplayInvocation &&
        latestToolCallId !== pendingInvocation.toolCallId
      ) {
        return false;
      }

      const now = new Date();
      const pausedUsage = pauseAgentExecution(
        normalizeAgentRunUsage(runRow.usage),
        now,
      );
      const [updatedRun] = await tx
        .update(agentRuns)
        .set({
          status: "awaiting_client_tool",
          usage: pausedUsage,
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
            eq(agentRuns.status, "running"),
            eq(agentRuns.executionLeaseId, input.leaseId),
          ),
        )
        .returning({ id: agentRuns.id });

      if (!updatedRun) {
        return false;
      }

      await tx.insert(agentRunEvents).values([
        {
          runId: input.runId,
          type: "client_tool.wait_recovered",
          payload: {
            toolCallId: pendingInvocation.toolCallId,
            toolName: pendingInvocation.toolName,
            currentRevision: runRow.currentRevision,
          },
        },
        {
          runId: input.runId,
          type: "run.status_changed",
          payload: {
            previousStatus: "running",
            status: "awaiting_client_tool",
            currentRevision: runRow.currentRevision,
            reason: "pending_client_tool_recovered",
          },
        },
      ]);

      return true;
    });
  }

  /**
   * 判断当前等待态是否由一条真实、尚未完成的客户端 Tool Ledger 支撑。
   *
   * 本方法只用于旧 Orchestrator 的错误收口：当它因租约竞争收到 runConflict，
   * 若数据库已经由新执行器建立健康等待态，就不应再把 Run 终止为 failed。
   */
  async hasPendingClientToolWait(input: {
    ownerId: string;
    runId: string;
  }): Promise<boolean> {
    const [runRow, pendingInvocations] = await Promise.all([
      this.db
        .select({
          status: agentRuns.status,
          currentRevision: agentRuns.currentRevision,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
          ),
        )
        .limit(1),
      this.db
        .select({
          revisionBefore: toolInvocations.revisionBefore,
        })
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.runId, input.runId),
            eq(toolInvocations.executionDomain, "client"),
            eq(toolInvocations.status, "running"),
          ),
        )
        .limit(2),
    ]);
    const run = runRow[0];

    return (
      run?.status === "awaiting_client_tool" &&
      pendingInvocations.length === 1 &&
      pendingInvocations[0]?.revisionBefore === run.currentRevision
    );
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
   * 客户端工具的 Ledger、Verification、Run 状态、租约释放和 SSE 事件必须
   * 同时落库。任何一步失败都会回滚，避免刷新后出现“Run 正在等待，但没有
   * running Tool Invocation 可恢复”的永久悬空状态。
   */
  async suspendForClientTool(
    input:
      | {
          ownerId: string;
          runId: string;
          projectId: string;
          toolCallId: string;
          toolName: typeof RUN_PREVIEW_TOOL_NAME;
          argumentsJson: RunPreviewToolArguments;
          idempotencyKey: string;
          revision: number;
          leaseId: string;
        }
      | {
          ownerId: string;
          runId: string;
          projectId: string;
          toolCallId: string;
          toolName: typeof BROWSER_VERIFY_TOOL_NAME;
          argumentsJson: BrowserVerifyToolArguments;
          idempotencyKey: string;
          revision: number;
          leaseId: string;
          source: "agent" | "replay";
          replayCount: number;
        },
  ): Promise<void> {
    await this.runTransaction(async (tx) => {
      const [lockedRun] = await tx
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          currentRevision: agentRuns.currentRevision,
          executionLeaseId: agentRuns.executionLeaseId,
          usage: agentRuns.usage,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
            eq(agentRuns.projectId, input.projectId),
          ),
        )
        .for("update");

      if (!lockedRun) {
        throw new AgentError(
          AGENT_ERROR_CODES.runNotFound,
          "Agent Run 不存在、项目不匹配或不属于当前匿名工作区。",
          404,
        );
      }

      const [existingInvocation] = await tx
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.runId, input.runId),
            eq(toolInvocations.toolCallId, input.toolCallId),
          ),
        );

      if (existingInvocation) {
        const isIdenticalPendingSuspend =
          lockedRun.status === "awaiting_client_tool" &&
          lockedRun.currentRevision === input.revision &&
          existingInvocation.toolName === input.toolName &&
          existingInvocation.executionDomain === "client" &&
          existingInvocation.status === "running" &&
          existingInvocation.idempotencyKey === input.idempotencyKey &&
          existingInvocation.revisionBefore === input.revision &&
          isDeepStrictEqual(
            existingInvocation.argumentsJson,
            input.argumentsJson,
          );

        if (isIdenticalPendingSuspend) {
          // Neon 上一个执行器可能已把同一 Tool Call 完整挂起，但旧执行器只收到
          // 连接中断或迟到的 CAS 结果。数据库中的等待态与 Ledger 已经构成事实，
          // 此处按幂等成功返回，且绝不能再次发布 requested/status 事件。
          return;
        }

        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          `重复的 ${input.toolName} Tool Call 不能再次下发浏览器。`,
          409,
          { toolCallId: input.toolCallId },
        );
      }

      // 在创建任何 Ledger 前先确认当前执行器仍拥有 Run。模型流可能持续较久，
      // 若租约已过期并被其他实例接管，必须在副作用前失败，不能留下半成品记录。
      if (
        lockedRun.status !== "running" ||
        lockedRun.currentRevision !== input.revision ||
        lockedRun.executionLeaseId !== input.leaseId
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.runConflict,
          "Agent Run 状态、revision 或执行租约已发生变化。",
          409,
        );
      }

      // 挂起事务和结果事务都先锁定同一条 Run。浏览器通常会在 SSE 到达后
      // 立即提交结果；若结果事务与本事务交叠，行锁会让它等到 awaiting 状态
      // 和 Tool Ledger 一起提交，再读取完整一致的数据库快照。
      const now = new Date();
      const pausedUsage = pauseAgentExecution(
        normalizeAgentRunUsage(lockedRun.usage),
        now,
      );
      const [invocation] = await tx
        .insert(toolInvocations)
        .values({
          runId: input.runId,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          executionDomain: "client",
          status: "running",
          argumentsJson: input.argumentsJson,
          idempotencyKey: input.idempotencyKey,
          revisionBefore: input.revision,
          startedAt: now,
        })
        .onConflictDoNothing({
          target: [toolInvocations.runId, toolInvocations.toolCallId],
        })
        .returning({ id: toolInvocations.id });

      if (!invocation) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          `重复的 ${input.toolName} Tool Call 不能再次下发浏览器。`,
          409,
          { toolCallId: input.toolCallId },
        );
      }

      let verificationRunId: string | null = null;
      if (input.toolName === BROWSER_VERIFY_TOOL_NAME) {
        const [verification] = await tx
          .insert(verificationRuns)
          .values({
            ownerId: input.ownerId,
            runId: input.runId,
            projectId: input.projectId,
            toolCallId: input.toolCallId,
            revision: input.revision,
            status: "running",
            source: input.source,
            replayCount: input.replayCount,
            smokeSteps: input.argumentsJson.steps,
            acceptedNetworkFailures:
              input.argumentsJson.acceptedNetworkFailures,
            startedAt: now,
          })
          .returning({ id: verificationRuns.id });

        if (!verification) {
          throw new Error("创建 Browser Verification Run 失败。");
        }
        verificationRunId = verification.id;
      }

      const [updatedRun] = await tx
        .update(agentRuns)
        .set({
          status: "awaiting_client_tool",
          usage: pausedUsage,
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
            eq(agentRuns.projectId, input.projectId),
            eq(agentRuns.status, "running"),
            eq(agentRuns.currentRevision, input.revision),
            eq(agentRuns.executionLeaseId, input.leaseId),
          ),
        )
        .returning({ currentRevision: agentRuns.currentRevision });

      if (!updatedRun) {
        const [latestRun] = await tx
          .select({
            status: agentRuns.status,
            currentRevision: agentRuns.currentRevision,
          })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, input.runId),
              eq(agentRuns.ownerId, input.ownerId),
              eq(agentRuns.projectId, input.projectId),
            ),
          );
        const [latestInvocation] = await tx
          .select()
          .from(toolInvocations)
          .where(
            and(
              eq(toolInvocations.runId, input.runId),
              eq(toolInvocations.toolCallId, input.toolCallId),
            ),
          );
        const isIdenticalPendingSuspend =
          latestRun?.status === "awaiting_client_tool" &&
          latestRun.currentRevision === input.revision &&
          latestInvocation?.toolName === input.toolName &&
          latestInvocation.executionDomain === "client" &&
          latestInvocation.status === "running" &&
          latestInvocation.idempotencyKey === input.idempotencyKey &&
          latestInvocation.revisionBefore === input.revision &&
          isDeepStrictEqual(
            latestInvocation.argumentsJson,
            input.argumentsJson,
          );

        if (isIdenticalPendingSuspend) {
          // 这是对 Neon 跨实例竞争的最后一道防线：若另一路径已经建立完全相同
          // 的等待事实，本次调用仍视为成功。事件由真正完成状态切换的一方发布。
          return;
        }

        throw new AgentError(
          AGENT_ERROR_CODES.runConflict,
          "Agent Run 状态、revision 或执行租约已发生变化。",
          409,
        );
      }

      await tx.insert(agentRunEvents).values([
        {
          runId: input.runId,
          type: "run.status_changed",
          payload: {
            previousStatus: "running",
            status: "awaiting_client_tool",
            currentRevision: updatedRun.currentRevision,
          },
        },
        {
          runId: input.runId,
          type: "client_tool.requested",
          payload: {
            runId: input.runId,
            projectId: input.projectId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            idempotencyKey: input.idempotencyKey,
            revision: input.revision,
            arguments: input.argumentsJson,
            ...(input.toolName === BROWSER_VERIFY_TOOL_NAME
              ? {
                  verificationRunId,
                  source: input.source,
                  replayCount: input.replayCount,
                }
              : {}),
          },
        },
      ]);
    });
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

  /**
   * canonical smoke plan 在客户端执行前落库。自动重放只复制这份事实，
   * 不从模型文本、SSE payload 或 React 临时状态反推步骤。
   */
  async createVerificationRun(input: {
    id?: string;
    ownerId: string;
    runId: string;
    projectId: string;
    toolCallId: string;
    revision: number;
    source: "agent" | "replay";
    replayCount: number;
    smokeSteps: Array<Record<string, unknown>>;
    acceptedNetworkFailures: Array<Record<string, unknown>>;
  }): Promise<VerificationRunRecord> {
    const [row] = await this.db
      .insert(verificationRuns)
      .values({
        ...(input.id ? { id: input.id } : {}),
        ownerId: input.ownerId,
        runId: input.runId,
        projectId: input.projectId,
        toolCallId: input.toolCallId,
        revision: input.revision,
        status: "running",
        source: input.source,
        replayCount: input.replayCount,
        smokeSteps: input.smokeSteps,
        acceptedNetworkFailures: input.acceptedNetworkFailures,
        startedAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error("创建 Browser Verification Run 失败。");
    }

    return toVerificationRunRecord(row);
  }

  async findReplayableSmokePlan(input: {
    ownerId: string;
    runId: string;
    currentRevision: number;
  }): Promise<VerificationRunRecord | null> {
    const [canonicalRows, latestRows] = await Promise.all([
      this.db
        .select()
        .from(verificationRuns)
        .where(
          and(
            eq(verificationRuns.ownerId, input.ownerId),
            eq(verificationRuns.runId, input.runId),
            eq(verificationRuns.source, "agent"),
            eq(verificationRuns.status, "failed"),
          ),
        )
        .orderBy(desc(verificationRuns.createdAt))
        .limit(1),
      this.db
        .select()
        .from(verificationRuns)
        .where(
          and(
            eq(verificationRuns.ownerId, input.ownerId),
            eq(verificationRuns.runId, input.runId),
          ),
        )
        .orderBy(desc(verificationRuns.createdAt))
        .limit(1),
    ]);
    const canonical = canonicalRows[0];
    const latest = latestRows[0];

    if (!canonical) {
      return null;
    }

    const [passedCurrentRevision] = await this.db
      .select({ id: verificationRuns.id })
      .from(verificationRuns)
      .where(
        and(
          eq(verificationRuns.ownerId, input.ownerId),
          eq(verificationRuns.runId, input.runId),
          eq(verificationRuns.revision, input.currentRevision),
          eq(verificationRuns.status, "passed"),
        ),
      )
      .limit(1);

    if (passedCurrentRevision) {
      return null;
    }

    // 步骤和网络白名单始终取 Agent 明确提交的 canonical plan；重放次数则
    // 延续该 Run 最新一轮验证，避免每次 mutation 后都重新显示为 replay 1。
    return {
      ...toVerificationRunRecord(canonical),
      replayCount: latest?.replayCount ?? canonical.replayCount,
    };
  }

  async getLatestVerificationRun(input: {
    ownerId: string;
    runId: string;
  }): Promise<VerificationRunRecord | null> {
    const [row] = await this.db
      .select()
      .from(verificationRuns)
      .where(
        and(
          eq(verificationRuns.ownerId, input.ownerId),
          eq(verificationRuns.runId, input.runId),
        ),
      )
      .orderBy(desc(verificationRuns.createdAt))
      .limit(1);

    return row ? toVerificationRunRecord(row) : null;
  }

  /**
   * 浏览器工具结果、Evidence、Transcript 与 Run 恢复必须原子提交。
   * 否则 Serverless 实例在任意两步之间中断时，会出现“证据已保存但 Run
   * 仍等待”或“Run 已继续但模型看不到 Tool Result”的不可恢复状态。
   */
  async completeClientToolResult(
    input: {
      ownerId: string;
      runId: string;
    } & ClientToolResultRequest,
  ): Promise<{
    disposition: "accepted" | "duplicate" | "ignored";
    run: AgentRunRecord;
  }> {
    return this.runTransaction(async (tx) => {
      const [runRow] = await tx
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
            eq(agentRuns.projectId, input.projectId),
          ),
        )
        .for("update");

      if (!runRow) {
        throw new AgentError(
          AGENT_ERROR_CODES.runNotFound,
          "Agent Run 不存在、项目不匹配或不属于当前匿名工作区。",
          404,
        );
      }

      // 必须先锁 Run 再读取 Ledger。否则结果事务可能先读到 running，随后等待
      // 尚未提交的 invocation；等待结束后仍沿用旧 Run 快照，便会把一份合法
      // 结果误记为 run_not_awaiting_client_tool。

      const [projectRow] = await tx
        .select({ revision: projects.revision })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            eq(projects.ownerId, input.ownerId),
            isNull(projects.deletedAt),
          ),
        );

      if (!projectRow) {
        throw new AgentError(
          AGENT_ERROR_CODES.runNotFound,
          "Agent Run 对应的项目不存在、已删除或不属于当前匿名工作区。",
          404,
        );
      }

      const [invocation] = await tx
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.runId, input.runId),
            eq(toolInvocations.toolCallId, input.toolCallId),
          ),
        );

      if (
        !invocation ||
        invocation.toolName !== input.toolName ||
        invocation.executionDomain !== "client" ||
        invocation.idempotencyKey !== input.idempotencyKey
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolInvalidArguments,
          "Client Tool Result 与已登记的 invocation 不匹配。",
          409,
          { toolCallId: input.toolCallId, toolName: input.toolName },
        );
      }

      let verificationRunRow: typeof verificationRuns.$inferSelect | null =
        null;
      let normalizedResult = input.result;
      let normalizedBrowserResult: BrowserVerifyResult | null = null;
      let verificationFailure =
        input.toolName === RUN_PREVIEW_TOOL_NAME
          ? deriveVerificationFailure(input.result)
          : null;
      let verificationSource: "agent" | "replay" = "agent";

      if (input.toolName === BROWSER_VERIFY_TOOL_NAME) {
        const argumentsResult = browserVerifyToolArgumentsSchema.safeParse(
          invocation.argumentsJson,
        );

        if (!argumentsResult.success) {
          throw new AgentError(
            AGENT_ERROR_CODES.toolInvalidArguments,
            "已登记的 browser_verify 参数不符合严格协议。",
            409,
            { issues: argumentsResult.error.issues },
          );
        }

        const [storedVerificationRun] = await tx
          .select()
          .from(verificationRuns)
          .where(
            and(
              eq(verificationRuns.id, input.result.verificationRunId),
              eq(verificationRuns.runId, input.runId),
              eq(verificationRuns.toolCallId, input.toolCallId),
              eq(verificationRuns.ownerId, input.ownerId),
              eq(verificationRuns.projectId, input.projectId),
            ),
          );

        if (!storedVerificationRun) {
          throw new AgentError(
            AGENT_ERROR_CODES.toolInvalidArguments,
            "Browser Verification Run 不存在或与 invocation 不匹配。",
            409,
          );
        }

        const evaluation = evaluateBrowserVerification({
          result: input.result,
          submittedRevision: input.revision,
          // projects.revision 是 Repository 的最终事实。Run revision 可能因为用户
          // 在浏览器验证期间另行保存文件而暂时落后，不能据此接受旧页面证据。
          currentRevision: projectRow.revision,
          smokeSteps: argumentsResult.data.steps,
          acceptedNetworkFailures: argumentsResult.data.acceptedNetworkFailures,
        });
        verificationRunRow = storedVerificationRun;
        normalizedResult = evaluation.result;
        normalizedBrowserResult = evaluation.result;
        verificationFailure = evaluation.failure;
        verificationSource = storedVerificationRun.source;
      }

      if (
        invocation.status === "succeeded" ||
        invocation.status === "failed" ||
        invocation.status === "cancelled"
      ) {
        if (
          invocation.resultJson &&
          isDeepStrictEqual(invocation.resultJson, normalizedResult)
        ) {
          return {
            disposition: "duplicate",
            run: toAgentRunRecord(runRow),
          };
        }

        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          "同一幂等键已经提交过不同的 Client Tool Result。",
          409,
        );
      }

      const ignoredReason =
        runRow.status !== "awaiting_client_tool"
          ? "run_not_awaiting_client_tool"
          : invocation.status !== "running"
            ? "invocation_not_running"
            : runRow.currentRevision !== input.revision ||
                projectRow.revision !== input.revision ||
                normalizedResult.revision !== input.revision
              ? "stale_revision"
              : null;

      if (ignoredReason) {
        await tx.insert(agentRunEvents).values({
          runId: input.runId,
          type: "client_tool.result_ignored",
          payload: {
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            reason: ignoredReason,
            submittedRevision: input.revision,
            currentRevision: runRow.currentRevision,
            repositoryRevision: projectRow.revision,
          },
        });

        return {
          disposition: "ignored",
          run: toAgentRunRecord(runRow),
        };
      }

      const invocationStatus = normalizedResult.ok ? "succeeded" : "failed";
      const now = new Date();
      const currentUsage = normalizeAgentRunUsage(runRow.usage);
      const repeatedFailureCount =
        verificationFailure &&
        currentUsage.latestVerificationRevision === input.revision &&
        currentUsage.latestFailureFingerprint ===
          verificationFailure.fingerprint
          ? currentUsage.repeatedFailureCount + 1
          : 0;
      const nextClientResumes = currentUsage.clientResumes + 1;
      const nextUsage = {
        ...currentUsage,
        clientResumes: nextClientResumes,
        repairRounds:
          currentUsage.clientResumes > 0
            ? currentUsage.repairRounds + 1
            : currentUsage.repairRounds,
        repeatedFailureCount,
        firstPreviewAt: currentUsage.firstPreviewAt ?? now.toISOString(),
        firstPreviewDurationMs:
          currentUsage.firstPreviewDurationMs ?? normalizedResult.durationMs,
        latestPreviewAt: now.toISOString(),
        latestVerificationRevision: input.revision,
        latestVerificationOk: normalizedResult.ok,
        latestFailureFingerprint: verificationFailure?.fingerprint ?? null,
      };
      const budget = normalizeAgentRunBudget(runRow.budget);
      const noProgress =
        !normalizedResult.ok &&
        repeatedFailureCount >= budget.maxNoProgressRepeats;
      const clientResumeBudgetExhausted =
        nextClientResumes > budget.maxClientResumes;
      const nextRunStatus =
        noProgress || clientResumeBudgetExhausted
          ? "budget_exhausted"
          : "running";
      const persistedUsage =
        nextRunStatus === "running"
          ? resumeAgentExecution(nextUsage, now)
          : nextUsage;
      const terminalErrorCode = noProgress
        ? AGENT_ERROR_CODES.noProgress
        : clientResumeBudgetExhausted
          ? AGENT_ERROR_CODES.budgetExhausted
          : null;
      const terminalErrorMessage = noProgress
        ? "同一种 Preview 失败在相同 revision 上重复出现，Agent 已停止无进展循环。"
        : clientResumeBudgetExhausted
          ? "Agent 已达到浏览器验证恢复次数上限。"
          : null;
      const [completedInvocation] = await tx
        .update(toolInvocations)
        .set({
          status: invocationStatus,
          resultJson: normalizedResult,
          revisionAfter: input.revision,
          errorCode: normalizedResult.ok
            ? null
            : input.toolName === BROWSER_VERIFY_TOOL_NAME
              ? "BROWSER_VERIFICATION_FAILED"
              : "PREVIEW_VERIFICATION_FAILED",
          completedAt: now,
        })
        .where(
          and(
            eq(toolInvocations.id, invocation.id),
            eq(toolInvocations.status, "running"),
          ),
        )
        .returning();

      if (!completedInvocation) {
        const [latestInvocation] = await tx
          .select()
          .from(toolInvocations)
          .where(eq(toolInvocations.id, invocation.id));

        if (
          latestInvocation?.resultJson &&
          isDeepStrictEqual(latestInvocation.resultJson, normalizedResult)
        ) {
          return {
            disposition: "duplicate",
            run: toAgentRunRecord(runRow),
          };
        }

        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          "Client Tool invocation 已被其他请求完成。",
          409,
        );
      }

      await tx.insert(agentEvidence).values([
        {
          runId: input.runId,
          toolCallId: input.toolCallId,
          projectId: input.projectId,
          ownerId: input.ownerId,
          revision: input.revision,
          kind: "build",
          payload: normalizedResult.build,
        },
        {
          runId: input.runId,
          toolCallId: input.toolCallId,
          projectId: input.projectId,
          ownerId: input.ownerId,
          revision: input.revision,
          kind: "runtime",
          payload: normalizedResult.runtime,
        },
        {
          runId: input.runId,
          toolCallId: input.toolCallId,
          projectId: input.projectId,
          ownerId: input.ownerId,
          revision: input.revision,
          kind: "console",
          payload: normalizedResult.console,
        },
      ]);

      if (verificationRunRow && normalizedBrowserResult) {
        await tx
          .update(verificationRuns)
          .set({
            status: normalizedBrowserResult.ok ? "passed" : "failed",
            buildEvidence: normalizedBrowserResult.build,
            runtimeEvidence: normalizedBrowserResult.runtime,
            consoleEvidence: normalizedBrowserResult.console,
            browserEvidence: normalizedBrowserResult.browser,
            networkEvidence: normalizedBrowserResult.network,
            buildOk: normalizedBrowserResult.checks.build,
            runtimeOk: normalizedBrowserResult.checks.runtime,
            consoleOk: normalizedBrowserResult.checks.console,
            networkOk: normalizedBrowserResult.checks.network,
            actionsOk: normalizedBrowserResult.checks.actions,
            assertionsOk: normalizedBrowserResult.checks.assertions,
            revisionOk: normalizedBrowserResult.checks.revision,
            failedStep: normalizedBrowserResult.browser.failedStep,
            summary: normalizedBrowserResult.summary,
            completedAt: now,
          })
          .where(
            and(
              eq(verificationRuns.id, verificationRunRow.id),
              inArray(verificationRuns.status, ["pending", "running"]),
            ),
          );

        if (normalizedBrowserResult.browser.steps.length > 0) {
          await tx
            .insert(verificationSteps)
            .values(
              normalizedBrowserResult.browser.steps.map((step) => ({
                verificationRunId: verificationRunRow.id,
                stepIndex: step.index,
                action: step.action,
                target: step.target,
                status: step.status,
                startedAt: new Date(step.startedAt),
                durationMs: step.durationMs,
                message: step.message,
                error: step.error,
              })),
            )
            .onConflictDoNothing();
        }
      }

      // Replay 是系统根据已保存 smoke plan 发起的，不存在新的 assistant tool_call。
      // 因此只把 Agent 原始调用或 run_preview 写入 Transcript；重放证据由
      // verification_runs 投影进下一轮 System Directive，避免制造孤立 tool 消息。
      if (
        input.toolName === RUN_PREVIEW_TOOL_NAME ||
        verificationSource === "agent"
      ) {
        await tx.insert(transcriptMessages).values({
          conversationId: runRow.conversationId,
          runId: runRow.id,
          role: "tool",
          kind: "tool_result",
          payload: {
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            resultJson: {
              ...normalizedResult,
              verificationFailure,
            },
          },
        });
      }

      const [updatedRun] = await tx
        .update(agentRuns)
        .set({
          status: nextRunStatus,
          usage: persistedUsage,
          errorCode: terminalErrorCode,
          errorMessage: terminalErrorMessage,
          completedAt: nextRunStatus === "budget_exhausted" ? now : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentRuns.id, input.runId),
            eq(agentRuns.ownerId, input.ownerId),
            eq(agentRuns.status, "awaiting_client_tool"),
          ),
        )
        .returning();

      if (!updatedRun) {
        throw new AgentError(
          AGENT_ERROR_CODES.runConflict,
          "Client Tool Result 提交时 Run 状态已发生变化。",
          409,
        );
      }

      await tx.insert(agentRunEvents).values([
        {
          runId: input.runId,
          type: "tool.completed",
          payload: {
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            ok: normalizedResult.ok,
            revision: input.revision,
          },
        },
        {
          runId: input.runId,
          type: "client_tool.completed",
          payload: {
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            ok: normalizedResult.ok,
            revision: input.revision,
          },
        },
        {
          runId: input.runId,
          type: "verification.completed",
          payload: {
            ok: normalizedResult.ok,
            revision: input.revision,
            clientResume: nextClientResumes,
            repairRound: nextUsage.repairRounds,
            repeatedFailureCount,
            verificationKind:
              input.toolName === BROWSER_VERIFY_TOOL_NAME
                ? "browser"
                : "preview",
            ...(verificationRunRow
              ? {
                  verificationRunId: verificationRunRow.id,
                  source: verificationRunRow.source,
                  replayCount: verificationRunRow.replayCount,
                  checks: normalizedBrowserResult?.checks,
                  failedStep:
                    normalizedBrowserResult?.browser.failedStep ?? null,
                }
              : {}),
            ...(verificationFailure ? { failure: verificationFailure } : {}),
          },
        },
        {
          runId: input.runId,
          type: "run.status_changed",
          payload: {
            previousStatus: "awaiting_client_tool",
            status: nextRunStatus,
            currentRevision: input.revision,
            ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
          },
        },
      ]);

      return {
        disposition: "accepted",
        run: toAgentRunRecord(updatedRun),
      };
    });
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
    budget: normalizeAgentRunBudget(row.budget),
    usage: normalizeAgentRunUsage(row.usage),
  };
}

function toVerificationRunRecord(
  row: typeof verificationRuns.$inferSelect,
): VerificationRunRecord {
  return {
    ...row,
    smokeSteps: row.smokeSteps,
    acceptedNetworkFailures: row.acceptedNetworkFailures,
    buildEvidence: row.buildEvidence ?? null,
    runtimeEvidence: row.runtimeEvidence ?? null,
    consoleEvidence: row.consoleEvidence ?? null,
    browserEvidence: row.browserEvidence ?? null,
    networkEvidence: row.networkEvidence ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
