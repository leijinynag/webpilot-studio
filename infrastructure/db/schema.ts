import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
  "unavailable",
  "error",
]);

export const browserGitMigrationStatus = pgEnum(
  "browser_git_migration_status",
  ["prepared", "completed", "cancelled"],
);

export const projectRevisionKind = pgEnum("project_revision_kind", [
  "initial",
  "write",
  "delete",
  "rename",
  "checkpoint",
  "restore",
]);

export const projectCheckpointKind = pgEnum("project_checkpoint_kind", [
  "agent_start",
  "agent_success",
  "restore",
]);

export const projectChangeOperation = pgEnum("project_change_operation", [
  "create",
  "update",
  "delete",
  "rename",
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

export const attachmentStatus = pgEnum("attachment_status", [
  "ready",
  "failed",
  "deleted",
]);

export const imageRunStatus = pgEnum("image_run_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const imageJobStatus = pgEnum("image_job_status", [
  "queued",
  "running",
  "retryable",
  "succeeded",
  "failed",
  "cancelled",
]);

export const projectAssetKind = pgEnum("project_asset_kind", [
  "uploaded_image",
  "generated_image",
]);

export const projectAssetSource = pgEnum("project_asset_source", [
  "attachment",
  "image_generation",
]);

export const agentEvidenceKind = pgEnum("agent_evidence_kind", [
  "build",
  "runtime",
  "console",
]);

export const verificationRunStatus = pgEnum("verification_run_status", [
  "pending",
  "running",
  "passed",
  "failed",
]);

export const verificationRunSource = pgEnum("verification_run_source", [
  "agent",
  "replay",
]);

export const verificationStepStatus = pgEnum("verification_step_status", [
  "passed",
  "failed",
]);

export const showcaseCaseStatus = pgEnum("showcase_case_status", [
  "draft",
  "published",
  "revoked",
]);

export const showcaseArtifactStatus = pgEnum("showcase_artifact_status", [
  "active",
  "revoked",
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
    // revision 0 表示项目已创建、但尚未写入任何文件。它仍是可被 Agent
    // checkpoint 引用的完整空快照，第一笔 mutation 会自然推进到 revision 1。
    check("project_revisions_revision_check", sql`${table.revision} >= 0`),
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

export const browserGitMigrationSessions = pgTable(
  "browser_git_migration_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    // 客户端只持有原始一次性 token，数据库仅保存 SHA-256 摘要。
    tokenHash: text("token_hash").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    candidateRepositoryId: text("candidate_repository_id").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    expectedHead: text("expected_head"),
    status: browserGitMigrationStatus("status")
      .notNull()
      .default("prepared"),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("browser_git_migrations_candidate_uidx").on(
      table.candidateRepositoryId,
    ),
    index("browser_git_migrations_owner_project_idx").on(
      table.ownerId,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    check(
      "browser_git_migrations_source_revision_check",
      sql`${table.sourceRevision} >= 0`,
    ),
    check(
      "browser_git_migrations_token_hash_check",
      sql`char_length(${table.tokenHash}) = 64`,
    ),
    check(
      "browser_git_migrations_manifest_hash_check",
      sql`char_length(${table.manifestHash}) = 64`,
    ),
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

export const projectCheckpoints = pgTable(
  "project_checkpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => projectRevisions.id, { onDelete: "restrict" }),
    runId: uuid("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    kind: projectCheckpointKind("kind").notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 同一 Run 的起点和成功快照只能各有一份。PostgreSQL unique 对 null
    // 不做互斥，因此 restore checkpoint 可以没有 Run 关联并持续追加。
    uniqueIndex("project_checkpoints_run_kind_uidx").on(
      table.runId,
      table.kind,
    ),
    index("project_checkpoints_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("project_checkpoints_revision_idx").on(table.revisionId),
  ],
);

export const projectChangeSets = pgTable(
  "project_change_sets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    baseCheckpointId: uuid("base_checkpoint_id")
      .notNull()
      .references(() => projectCheckpoints.id, { onDelete: "restrict" }),
    resultCheckpointId: uuid("result_checkpoint_id")
      .notNull()
      .references(() => projectCheckpoints.id, { onDelete: "restrict" }),
    baseRevision: integer("base_revision").notNull(),
    resultRevision: integer("result_revision").notNull(),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("project_change_sets_run_uidx").on(table.runId),
    index("project_change_sets_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    check(
      "project_change_sets_revision_order_check",
      sql`${table.baseRevision} <= ${table.resultRevision}`,
    ),
  ],
);

export const projectChangeSetFiles = pgTable(
  "project_change_set_files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    changeSetId: uuid("change_set_id")
      .notNull()
      .references(() => projectChangeSets.id, { onDelete: "cascade" }),
    operation: projectChangeOperation("operation").notNull(),
    pathBefore: text("path_before"),
    pathAfter: text("path_after"),
    beforeHash: text("before_hash").references(() => projectFileBlobs.hash),
    afterHash: text("after_hash").references(() => projectFileBlobs.hash),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [
    uniqueIndex("project_change_set_files_order_uidx").on(
      table.changeSetId,
      table.sortOrder,
    ),
    index("project_change_set_files_change_idx").on(
      table.changeSetId,
      table.operation,
    ),
    check(
      "project_change_set_files_sort_order_check",
      sql`${table.sortOrder} >= 0`,
    ),
    check(
      "project_change_set_files_shape_check",
      sql`
        (${table.operation} = 'create' and ${table.pathBefore} is null and ${table.pathAfter} is not null and ${table.beforeHash} is null and ${table.afterHash} is not null)
        or (${table.operation} = 'update' and ${table.pathBefore} is not null and ${table.pathAfter} is not null and ${table.beforeHash} is not null and ${table.afterHash} is not null)
        or (${table.operation} = 'delete' and ${table.pathBefore} is not null and ${table.pathAfter} is null and ${table.beforeHash} is not null and ${table.afterHash} is null)
        or (${table.operation} = 'rename' and ${table.pathBefore} is not null and ${table.pathAfter} is not null and ${table.beforeHash} is not null and ${table.afterHash} is not null)
      `,
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

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    blobUrl: text("blob_url").notNull(),
    width: integer("width"),
    height: integer("height"),
    status: attachmentStatus("status").notNull().default("ready"),
    errorCode: text("error_code"),
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
    check("chat_attachments_byte_length_check", sql`${table.byteLength} > 0`),
    check(
      "chat_attachments_sha256_check",
      sql`char_length(${table.sha256}) = 64`,
    ),
    check(
      "chat_attachments_dimensions_check",
      sql`
        (${table.width} is null and ${table.height} is null)
        or (${table.width} is not null and ${table.width} > 0 and ${table.height} is not null and ${table.height} > 0)
      `,
    ),
    index("chat_attachments_owner_project_idx").on(
      table.ownerId,
      table.projectId,
      table.deletedAt,
      table.createdAt,
    ),
    index("chat_attachments_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const imageRuns = pgTable(
  "image_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    parentAgentRunId: uuid("parent_agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    toolCallId: text("tool_call_id").notNull(),
    prompt: text("prompt").notNull(),
    requestedCount: integer("requested_count").notNull(),
    size: text("size").notNull().default("1024x1024"),
    status: imageRunStatus("status").notNull().default("queued"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    profile: text("profile").notNull(),
    profileVersion: text("profile_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
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
    check(
      "image_runs_requested_count_check",
      sql`${table.requestedCount} between 1 and 4`,
    ),
    check(
      "image_runs_size_check",
      sql`${table.size} in ('1024x1024', '1024x1536', '1536x1024')`,
    ),
    uniqueIndex("image_runs_idempotency_uidx").on(table.idempotencyKey),
    index("image_runs_owner_project_status_idx").on(
      table.ownerId,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index("image_runs_parent_agent_run_idx").on(table.parentAgentRunId),
  ],
);

export const imageJobs = pgTable(
  "image_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    imageRunId: uuid("image_run_id")
      .notNull()
      .references(() => imageRuns.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: imageJobStatus("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    idempotencyKey: text("idempotency_key").notNull(),
    providerJobId: text("provider_job_id"),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    nextAttemptAt: timestamp("next_attempt_at", {
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
    check("image_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "image_jobs_max_attempts_check",
      sql`${table.maxAttempts} between 1 and 5`,
    ),
    uniqueIndex("image_jobs_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("image_jobs_image_run_uidx").on(table.imageRunId),
    index("image_jobs_status_next_attempt_idx").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("image_jobs_lease_idx").on(table.status, table.leaseExpiresAt),
    index("image_jobs_owner_project_idx").on(
      table.ownerId,
      table.projectId,
      table.updatedAt,
    ),
  ],
);

export const projectAssets = pgTable(
  "project_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    attachmentId: uuid("attachment_id").references(() => chatAttachments.id, {
      onDelete: "set null",
    }),
    imageRunId: uuid("image_run_id").references(() => imageRuns.id, {
      onDelete: "set null",
    }),
    generationIndex: integer("generation_index"),
    kind: projectAssetKind("kind").notNull(),
    source: projectAssetSource("source").notNull(),
    originalFilename: text("original_filename"),
    mimeType: text("mime_type").notNull(),
    byteLength: integer("byte_length").notNull(),
    sha256: text("sha256").notNull(),
    blobPathname: text("blob_pathname").notNull(),
    blobUrl: text("blob_url").notNull(),
    width: integer("width"),
    height: integer("height"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", {
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
    check("project_assets_byte_length_check", sql`${table.byteLength} > 0`),
    check(
      "project_assets_sha256_check",
      sql`char_length(${table.sha256}) = 64`,
    ),
    check(
      "project_assets_dimensions_check",
      sql`
        (${table.width} is null and ${table.height} is null)
        or (${table.width} is not null and ${table.width} > 0 and ${table.height} is not null and ${table.height} > 0)
      `,
    ),
    check(
      "project_assets_generation_index_check",
      sql`${table.generationIndex} is null or ${table.generationIndex} >= 0`,
    ),
    uniqueIndex("project_assets_project_hash_active_uidx")
      .on(table.projectId, table.sha256)
      .where(sql`${table.deletedAt} is null`),
    index("project_assets_owner_project_idx").on(
      table.ownerId,
      table.projectId,
      table.deletedAt,
      table.createdAt,
    ),
    index("project_assets_image_run_idx").on(table.imageRunId),
    uniqueIndex("project_assets_image_run_generation_uidx")
      .on(table.imageRunId, table.generationIndex)
      .where(
        sql`${table.imageRunId} is not null and ${table.generationIndex} is not null and ${table.deletedAt} is null`,
      ),
  ],
);

export const agentEvidence = pgTable(
  "agent_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    revision: integer("revision").notNull(),
    kind: agentEvidenceKind("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("agent_evidence_revision_check", sql`${table.revision} >= 0`),
    uniqueIndex("agent_evidence_run_call_kind_uidx").on(
      table.runId,
      table.toolCallId,
      table.kind,
    ),
    index("agent_evidence_project_revision_idx").on(
      table.projectId,
      table.revision,
      table.createdAt,
    ),
    index("agent_evidence_owner_run_idx").on(
      table.ownerId,
      table.runId,
      table.createdAt,
    ),
  ],
);

export const verificationRuns = pgTable(
  "verification_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // created_at 只有毫秒级时间精度，同一事务内的初始验证和 replay
    // 可能拥有相同时间戳。使用数据库生成的单调序列读取最新事实，避免
    // completion gate 因排序不稳定继续消耗模型轮次。
    seq: bigint("seq", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    revision: integer("revision").notNull(),
    status: verificationRunStatus("status").notNull().default("pending"),
    source: verificationRunSource("source").notNull(),
    replayCount: integer("replay_count").notNull().default(0),
    // 原始 smoke plan 与网络白名单作为可自动重放的事实保存，不能只留在 Transcript。
    smokeSteps: jsonb("smoke_steps")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    acceptedNetworkFailures: jsonb("accepted_network_failures")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default([]),
    buildEvidence: jsonb("build_evidence").$type<Record<string, unknown>>(),
    runtimeEvidence: jsonb("runtime_evidence").$type<Record<string, unknown>>(),
    consoleEvidence: jsonb("console_evidence").$type<Record<string, unknown>>(),
    browserEvidence: jsonb("browser_evidence").$type<Record<string, unknown>>(),
    networkEvidence: jsonb("network_evidence").$type<Record<string, unknown>>(),
    buildOk: boolean("build_ok"),
    runtimeOk: boolean("runtime_ok"),
    consoleOk: boolean("console_ok"),
    networkOk: boolean("network_ok"),
    actionsOk: boolean("actions_ok"),
    assertionsOk: boolean("assertions_ok"),
    revisionOk: boolean("revision_ok"),
    failedStep: integer("failed_step"),
    summary: text("summary"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("verification_runs_run_call_uidx").on(
      table.runId,
      table.toolCallId,
    ),
    index("verification_runs_run_revision_idx").on(
      table.runId,
      table.revision,
      table.createdAt,
    ),
    index("verification_runs_project_revision_idx").on(
      table.projectId,
      table.revision,
      table.createdAt,
    ),
    check("verification_runs_revision_check", sql`${table.revision} >= 0`),
    check(
      "verification_runs_replay_count_check",
      sql`${table.replayCount} >= 0`,
    ),
    check(
      "verification_runs_failed_step_check",
      sql`${table.failedStep} is null or ${table.failedStep} >= 0`,
    ),
  ],
);

export const verificationSteps = pgTable(
  "verification_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    verificationRunId: uuid("verification_run_id")
      .notNull()
      .references(() => verificationRuns.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    action: text("action").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>(),
    status: verificationStepStatus("status").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    message: text("message").notNull(),
    error: jsonb("error").$type<Record<string, unknown>>(),
  },
  (table) => [
    uniqueIndex("verification_steps_run_index_uidx").on(
      table.verificationRunId,
      table.stepIndex,
    ),
    index("verification_steps_run_status_idx").on(
      table.verificationRunId,
      table.status,
      table.stepIndex,
    ),
    check("verification_steps_index_check", sql`${table.stepIndex} >= 0`),
    check("verification_steps_duration_check", sql`${table.durationMs} >= 0`),
  ],
);

export const showcaseCases = pgTable(
  "showcase_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    coverUrl: text("cover_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: showcaseCaseStatus("status").notNull().default("draft"),
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
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "date",
    }),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("showcase_cases_slug_uidx").on(table.slug),
    index("showcase_cases_public_sort_idx").on(
      table.status,
      table.sortOrder,
      table.updatedAt,
    ),
    check(
      "showcase_cases_title_length_check",
      sql`char_length(${table.title}) between 1 and 160`,
    ),
    check(
      "showcase_cases_slug_format_check",
      sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`,
    ),
  ],
);

export const showcaseArtifacts = pgTable(
  "showcase_artifacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => showcaseCases.id, { onDelete: "cascade" }),
    sourceRevision: integer("source_revision").notNull(),
    status: showcaseArtifactStatus("status").notNull().default("active"),
    blobPrefix: text("blob_prefix").notNull(),
    entryPath: text("entry_path").notNull().default("index.html"),
    manifest: jsonb("manifest")
      .$type<{
        format: "webpilot-showcase-artifact-v1";
        entryPath: "index.html";
        files: Array<{
          path: string;
          byteLength: number;
          hash: string;
        }>;
        totalBytes: number;
        createdAt: string;
      }>()
      .notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("showcase_artifacts_case_revision_uidx").on(
      table.caseId,
      table.sourceRevision,
      table.createdAt,
    ),
    index("showcase_artifacts_case_status_idx").on(
      table.caseId,
      table.status,
      table.createdAt,
    ),
    check(
      "showcase_artifacts_source_revision_check",
      sql`${table.sourceRevision} >= 0`,
    ),
    check("showcase_artifacts_file_count_check", sql`${table.fileCount} > 0`),
    check("showcase_artifacts_total_bytes_check", sql`${table.totalBytes} >= 0`),
  ],
);

export const databaseSchema = {
  projects,
  projectFileBlobs,
  projectFiles,
  projectRevisions,
  projectRevisionFiles,
  browserGitMigrationSessions,
  projectCheckpoints,
  projectChangeSets,
  projectChangeSetFiles,
  conversations,
  transcriptMessages,
  agentRuns,
  agentRunEvents,
  toolInvocations,
  chatAttachments,
  imageRuns,
  imageJobs,
  projectAssets,
  agentEvidence,
  verificationRuns,
  verificationSteps,
  showcaseCases,
  showcaseArtifacts,
};

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectFileRow = typeof projectFiles.$inferSelect;
export type ShowcaseCaseRow = typeof showcaseCases.$inferSelect;
export type ShowcaseArtifactManifestRow =
  typeof showcaseArtifacts.$inferSelect;
export type ChatAttachmentRow = typeof chatAttachments.$inferSelect;
export type ImageRunRow = typeof imageRuns.$inferSelect;
export type ImageJobRow = typeof imageJobs.$inferSelect;
export type ProjectAssetRow = typeof projectAssets.$inferSelect;
