import { Pool } from "@neondatabase/serverless";
import { config } from "dotenv";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { drizzle } from "drizzle-orm/neon-serverless";

import { databaseSchema } from "@/infrastructure/db/schema";

// 独立 CLI 不经过 Next.js 的环境加载器，因此显式复用本地开发的优先级：
// .env.local 覆盖 .env；已有 shell 环境变量始终保持最高优先级。
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("执行数据库迁移前必须配置 DATABASE_URL。");
}

async function main() {
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
}

void main();
