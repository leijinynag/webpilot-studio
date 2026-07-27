import { neon } from "@neondatabase/serverless";

export type DatabaseHealthResult = {
  provider: "neon";
  status: "ok";
  readOnly: true;
};

type HealthRow = {
  health?: unknown;
};

export type DatabaseHealthQuery = () => Promise<readonly HealthRow[]>;

/**
 * 数据库健康检查只验证“可以建立连接并读取结果”，不创建表、不写入数据。
 *
 * 查询函数作为依赖传入，既让失败分支可以稳定单测，也避免领域代码直接依赖
 * Neon SDK。后续接入 Drizzle 时，迁移和 Repository 检查会拥有各自独立的职责。
 */
export async function verifyDatabaseReadAccess(
  query: DatabaseHealthQuery,
): Promise<DatabaseHealthResult> {
  const rows = await query();

  if (rows[0]?.health !== 1) {
    throw new Error("Neon 健康检查返回了非预期结果。");
  }

  return {
    provider: "neon",
    status: "ok",
    readOnly: true,
  };
}

/**
 * Neon HTTP Driver 适合 Vercel 的短生命周期函数：一次检查对应一次 HTTP 查询，
 * 不在模块级维护长连接池。readOnly 同时声明本次事务边界不允许写入。
 */
export function checkNeonDatabase(
  databaseUrl: string,
): Promise<DatabaseHealthResult> {
  const sql = neon(databaseUrl, { readOnly: true });

  return verifyDatabaseReadAccess(
    async () => await sql`SELECT 1::int AS health`,
  );
}
