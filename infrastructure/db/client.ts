import "server-only";

import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { NeonTransaction } from "drizzle-orm/neon-serverless";
import type { PgTransactionConfig } from "drizzle-orm/pg-core/session";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";

import { databaseSchema } from "@/infrastructure/db/schema";
import { serverEnv } from "@/infrastructure/env/server";

/**
 * 普通查询交给 Neon HTTP 通道，省去开发环境和 Serverless 请求中的
 * WebSocket 建连成本。显式事务会调用 Pool.connect()，仍然使用一条
 * 持久连接完成 BEGIN/COMMIT，不会被拆成多个 HTTP 请求。
 *
 * 项目要求 Node 22，其内置 WebSocket 已满足 Neon 驱动需要，因此不要再
 * 注入 `ws` 包。Webpack 打包 `ws` 的可选原生扩展时可能得到不完整模块，
 * 最终会在发送握手数据时触发 `bufferUtil.mask is not a function`。
 */
neonConfig.poolQueryViaFetch = true;

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

function getDatabasePool(): Pool {
  const pool =
    globalDatabase.webpilotDatabasePool ??
    new Pool({
      connectionString: requireDatabaseUrl(),
      max: 4,
    });

  if (process.env.NODE_ENV !== "production") {
    globalDatabase.webpilotDatabasePool = pool;
  }

  return pool;
}

/**
 * 开发模式复用 Pool，避免 Next.js 热更新反复创建 WebSocket 连接。
 * Vercel 生产实例也只会在当前函数实例生命周期内缓存，不承担跨实例状态。
 */
export function getDatabase() {
  return drizzle(getDatabasePool(), { schema: databaseSchema });
}

export type AppDatabase = ReturnType<typeof getDatabase>;

type RelationalSchema = ExtractTablesWithRelations<typeof databaseSchema>;
export type AppDatabaseTransaction = NeonTransaction<
  typeof databaseSchema,
  RelationalSchema
>;

/**
 * 在一条显式获取的 PoolClient 上执行数据库事务。
 *
 * Drizzle 的 Neon Pool 事务会通过 `client instanceof Pool` 判断是否需要
 * `pool.connect()`。Next.js/Turbopack 开发热更新可能让全局缓存的 Pool 与当前
 * bundle 中的 Pool 构造器来自不同模块实例，使该判断失效，BEGIN、业务查询和
 * COMMIT 被 Pool 分配到不同连接。除了破坏原子性，还会让连接残留在事务中，
 * 后续出现 25001、25006 或 checkpoint 外键不可见等看似无关的错误。
 *
 * 这里直接获取 PoolClient，保证事务的全部语句使用同一条连接。事务开始前先
 * 执行一次 ROLLBACK，清理旧版本热更新可能遗留的事务；异常时再做一次兜底
 * ROLLBACK，若连接已经无法复位，则销毁而不是放回连接池污染后续请求。
 */
export async function runDatabaseTransaction<T>(
  operation: (transaction: AppDatabaseTransaction) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  const client = await getDatabasePool().connect();
  let destroyConnection = false;

  try {
    // PostgreSQL 在空闲连接上执行 ROLLBACK 只会返回 warning，不会中断请求。
    // 这一步专门兼容修复前已经进入连接池的脏连接，后续新连接也可安全执行。
    await client.query("rollback");
    const database = drizzle(client, { schema: databaseSchema });
    return await database.transaction(operation, config);
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // 网络断开或协议状态损坏时不能继续复用该连接。
      destroyConnection = true;
    }
    throw error;
  } finally {
    client.release(destroyConnection);
  }
}
