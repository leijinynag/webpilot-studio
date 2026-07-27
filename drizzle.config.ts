import "dotenv/config";

import { defineConfig } from "drizzle-kit";

// generate 只读取 schema，不会连接数据库；使用占位 URL 让首次 clone 后
// 可以直接生成迁移。真正的 migrate 命令会在 scripts/migrate-database.ts
// 内单独要求真实 DATABASE_URL。
const databaseUrl =
  process.env.DATABASE_URL?.trim() || "postgresql://localhost/webpilot_studio";

export default defineConfig({
  dialect: "postgresql",
  schema: "./infrastructure/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl,
  },
  // 首版只管理 public schema，避免误把 Neon 自带对象纳入迁移。
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
