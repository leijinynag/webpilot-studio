import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projectStorageKind = pgEnum("project_storage_kind", [
  "database",
  "browser_git",
]);

export const projectStatus = pgEnum("project_status", [
  "creating",
  "ready",
  "error",
]);

export const projectRevisionKind = pgEnum("project_revision_kind", [
  "initial",
  "write",
  "delete",
  "rename",
  "checkpoint",
  "restore",
]);

export const transcriptMessageRole = pgEnum("transcript_message_role", [
  "user",
  "assistant",
  "tool",
  "system",
]);

export const transcriptMessageKind = pgEnum("transcript_message_kind", [
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "system_event",
]);

export const agentRunStatus = pgEnum("agent_run_status", [
  "queued",
  "running",
  "awaiting_client_tool",
  "awaiting_async_job",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "conflicted",
]);

export const toolExecutionDomain = pgEnum("tool_execution_domain", [
  "server",
  "client",
  "async_worker",
]);

export const toolInvocationStatus = pgEnum("tool_invocation_status", [
  "created",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // ownerId 只由已验证匿名会话提供，不暴露为可由客户端填写的字段。
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    storageKind: projectStorageKind("storage_kind")
      .notNull()
      .default("database"),
    status: projectStatus("status").notNull().default("creating"),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "projects_name_length_check",
      sql`char_length(${table.name}) between 1 and 120`,
    ),
    check("projects_revision_check", sql`${table.revision} >= 0`),
    index("projects_owner_updated_idx").on(
      table.ownerId,
      table.deletedAt,
      table.updatedAt,
    ),
  ],
);

export const projectFileBlobs = pgTable(
  "project_file_blobs",
  {
    // SHA-256 十六进制摘要作为内容地址，相同内容只存储一次。
    hash: text("hash").primaryKey(),
    content: text("content").notNull(),
    byteLength: integer("byte_length").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "project_file_blobs_hash_check",
      sql`char_length(${table.hash}) = 64`,
    ),
    check(
      "project_file_blobs_byte_length_check",
      sql`${table.byteLength} >= 0`,
    ),
  ],
);

export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => projectFileBlobs.hash),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    // 删除后保留同一路径记录；再次写入时恢复该记录而不是制造重复路径。
    uniqueIndex("project_files_project_path_uidx").on(
      table.projectId,
      table.path,
    ),
    index("project_files_project_active_idx").on(
      table.projectId,
      table.deletedAt,
      table.path,
    ),
  ],
);

export const projectRevisions = pgTable(
  "project_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    kind: projectRevisionKind("kind").notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_revisions_project_revision_uidx").on(
      table.projectId,
      table.revision,
    ),
    index("project_revisions_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    check("project_revisions_revision_check", sql`${table.revision} >= 1`),
  ],
);

export const projectRevisionFiles = pgTable(
  "project_revision_files",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => projectRevisions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobHash: text("blob_hash")
      .notNull()
      .references(() => projectFileBlobs.hash),
  },
  (table) => [
    primaryKey({
      name: "project_revision_files_pk",
      columns: [table.revisionId, table.path],
    }),
    index("project_revision_files_blob_idx").on(table.blobHash),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // ownerId 被冗余保存在会话与 Run 上，查询时始终以 owner 作为第一层隔离条件。
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    check(
      "conversations_title_length_check",
      sql`char_length(${table.title}) between 1 and 160`,
    ),
    index("conversations_owner_project_idx").on(
      table.ownerId,
      table.projectId,
      table.deletedAt,
      table.updatedAt,
    ),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    status: agentRunStatus("status").notNull().default("queued"),
    startRevision: integer("start_revision").notNull(),
    currentRevision: integer("current_revision").notNull(),
    locale: text("locale").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptProfile: text("prompt_profile").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    toolsetProfile: text("toolset_profile").notNull(),
    toolsetDigest: text("toolset_digest").notNull(),
    modelProfile: text("model_profile").notNull(),
    repositoryCapability: jsonb("repository_capability")
      .$type<Record<string, unknown>>()
      .notNull(),
    budget: jsonb("budget").$type<Record<string, unknown>>().notNull(),
    usage: jsonb("usage")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    correlationId: uuid("correlation_id").notNull(),
    executionLeaseId: uuid("execution_lease_id"),
    executionLeaseExpiresAt: timestamp("execution_lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    cancellationRequestedAt: timestamp("cancellation_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("agent_runs_start_revision_check", sql`${table.startRevision} >= 0`),
    check(
      "agent_runs_current_revision_check",
      sql`${table.currentRevision} >= ${table.startRevision}`,
    ),
    uniqueIndex("agent_runs_correlation_uidx").on(table.correlationId),
    index("agent_runs_owner_status_idx").on(
      table.ownerId,
      table.status,
      table.updatedAt,
    ),
    index("agent_runs_project_status_idx").on(
      table.projectId,
      table.status,
      table.updatedAt,
    ),
    // 并发预检改善错误提示；partial unique index 才是跨实例竞争时的最终原子边界。
    uniqueIndex("agent_runs_project_active_uidx")
      .on(table.projectId)
      .where(
        sql`${table.status} in ('queued', 'running', 'awaiting_client_tool', 'awaiting_async_job')`,
      ),
    index("agent_runs_lease_idx").on(
      table.status,
      table.executionLeaseExpiresAt,
    ),
  ],
);

export const transcriptMessages = pgTable(
  "transcript_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    // identity 由 PostgreSQL 分配，禁止使用 MAX(seq) + 1。
    seq: bigint("seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    role: transcriptMessageRole("role").notNull(),
    kind: transcriptMessageKind("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("transcript_messages_conversation_seq_uidx").on(
      table.conversationId,
      table.seq,
    ),
    index("transcript_messages_run_seq_idx").on(table.runId, table.seq),
  ],
);

export const agentRunEvents = pgTable(
  "agent_run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    // 全局单调序列可以直接作为 SSE cursor；查询仍会同时限制 runId。
    sequence: bigint("sequence", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_run_events_run_sequence_uidx").on(
      table.runId,
      table.sequence,
    ),
    index("agent_run_events_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    executionDomain: toolExecutionDomain("execution_domain").notNull(),
    status: toolInvocationStatus("status").notNull().default("created"),
    argumentsJson: jsonb("arguments_json")
      .$type<Record<string, unknown>>()
      .notNull(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key").notNull(),
    revisionBefore: integer("revision_before"),
    revisionAfter: integer("revision_after"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("tool_invocations_run_call_uidx").on(
      table.runId,
      table.toolCallId,
    ),
    uniqueIndex("tool_invocations_idempotency_uidx").on(table.idempotencyKey),
    index("tool_invocations_run_status_idx").on(
      table.runId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const databaseSchema = {
  projects,
  projectFileBlobs,
  projectFiles,
  projectRevisions,
  projectRevisionFiles,
  conversations,
  transcriptMessages,
  agentRuns,
  agentRunEvents,
  toolInvocations,
};

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectFileRow = typeof projectFiles.$inferSelect;
