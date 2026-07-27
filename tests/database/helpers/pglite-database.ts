import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { databaseSchema } from "@/infrastructure/db/schema";

/**
 * 每个数据库测试使用独立的内存 PostgreSQL。
 * 这里执行仓库内真实 migration，而不是直接 push schema，确保测试覆盖部署路径。
 */
export async function createTestDatabase() {
  const client = new PGlite();
  const database = drizzle(client, { schema: databaseSchema });

  await migrate(database, { migrationsFolder: "./drizzle" });

  return {
    client,
    database,
    async close() {
      await client.close();
    },
  };
}
