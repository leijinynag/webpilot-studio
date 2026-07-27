import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
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

export const databaseSchema = {
  projects,
  projectFileBlobs,
  projectFiles,
  projectRevisions,
  projectRevisionFiles,
};

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectFileRow = typeof projectFiles.$inferSelect;
