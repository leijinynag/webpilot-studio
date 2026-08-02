import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

describe("database migration", () => {
  it("creates the complete project persistence schema", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const result = await testDatabase.database.execute<{
        table_name: string;
      }>(sql`
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_name in (
            'agent_run_events',
            'agent_runs',
            'agent_evidence',
            'chat_attachments',
            'conversations',
            'image_jobs',
            'image_runs',
            'projects',
            'project_assets',
            'project_change_set_files',
            'project_change_sets',
            'project_checkpoints',
            'project_files',
            'project_file_blobs',
            'project_revisions',
            'project_revision_files',
            'showcase_artifacts',
            'showcase_cases',
            'tool_invocations',
            'transcript_messages',
            'verification_runs',
            'verification_steps'
          )
        order by table_name
      `);

      expect(result.rows.map((row) => row.table_name)).toEqual([
        "agent_evidence",
        "agent_run_events",
        "agent_runs",
        "chat_attachments",
        "conversations",
        "image_jobs",
        "image_runs",
        "project_assets",
        "project_change_set_files",
        "project_change_sets",
        "project_checkpoints",
        "project_file_blobs",
        "project_files",
        "project_revision_files",
        "project_revisions",
        "projects",
        "showcase_artifacts",
        "showcase_cases",
        "tool_invocations",
        "transcript_messages",
        "verification_runs",
        "verification_steps",
      ]);
    } finally {
      await testDatabase.close();
    }
  });
});
