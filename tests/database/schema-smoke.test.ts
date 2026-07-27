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
            'projects',
            'project_files',
            'project_file_blobs',
            'project_revisions',
            'project_revision_files'
          )
        order by table_name
      `);

      expect(result.rows.map((row) => row.table_name)).toEqual([
        "project_file_blobs",
        "project_files",
        "project_revision_files",
        "project_revisions",
        "projects",
      ]);
    } finally {
      await testDatabase.close();
    }
  });
});
