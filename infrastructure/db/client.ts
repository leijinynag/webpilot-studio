import "server-only";

import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import { databaseSchema } from "@/infrastructure/db/schema";
import { serverEnv } from "@/infrastructure/env/server";

neonConfig.webSocketConstructor = ws;

function requireDatabaseUrl(): string {
  const value = serverEnv.DATABASE_URL?.trim();

  if (!value) {
    throw new Error("数据库功能需要配置 DATABASE_URL。");
  }

  return value;
}

const globalDatabase = globalThis as typeof globalThis & {
  webpilotDatabasePool?: Pool;
};

/**
 * 开发模式复用 Pool，避免 Next.js 热更新反复创建 WebSocket 连接。
 * Vercel 生产实例也只会在当前函数实例生命周期内缓存，不承担跨实例状态。
 */
export function getDatabase() {
  const pool =
    globalDatabase.webpilotDatabasePool ??
    new Pool({
      connectionString: requireDatabaseUrl(),
      max: 4,
    });

  if (process.env.NODE_ENV !== "production") {
    globalDatabase.webpilotDatabasePool = pool;
  }

  return drizzle(pool, { schema: databaseSchema });
}

export type AppDatabase = ReturnType<typeof getDatabase>;
