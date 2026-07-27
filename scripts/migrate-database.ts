import "dotenv/config";

import { Pool } from "@neondatabase/serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { drizzle } from "drizzle-orm/neon-serverless";

import { databaseSchema } from "@/infrastructure/db/schema";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("执行数据库迁移前必须配置 DATABASE_URL。");
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
});
const database = drizzle(pool, { schema: databaseSchema });

try {
  // 迁移由显式命令执行，不放进 Next.js 启动流程，避免多个实例同时抢迁移锁。
  await migrate(database, { migrationsFolder: "./drizzle" });
} finally {
  await pool.end();
}
