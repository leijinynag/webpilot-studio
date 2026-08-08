import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { isAgentError } from "@/domains/agent/errors";
import { isQuotaError } from "@/infrastructure/quota/errors";
import { AgentStore } from "@/domains/agent/store";
import { isProjectError } from "@/domains/project/errors";
import { ProjectHistoryService } from "@/domains/project/history";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import {
  getDatabase,
  runDatabaseTransaction,
} from "@/infrastructure/db/client";

type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: Record<string, unknown>;
  };
};

export function createRequestCorrelationId(request: Request): string {
  const incoming = request.headers.get("x-correlation-id");
  return incoming && z.uuid().safeParse(incoming).success
    ? incoming
    : randomUUID();
}

export function agentJsonResponse<T>(
  body: T,
  correlationId: string,
  init?: ResponseInit,
) {
  const response = NextResponse.json(body, init);
  response.headers.set("x-correlation-id", correlationId);
  // Agent Run 与聚合快照是高频变化的数据库事实。无论 GET 还是 mutation
  // 响应都禁止浏览器、CDN 或 Next 数据缓存复用，避免刷新读到旧终态。
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export function agentApiErrorResponse(
  error: unknown,
  correlationId: string,
): NextResponse<ApiErrorBody> {
  if (isAgentError(error) || isProjectError(error) || isQuotaError(error)) {
    return agentJsonResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          correlationId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      correlationId,
      { status: error.status },
    );
  }

  if (error instanceof z.ZodError) {
    return agentJsonResponse(
      {
        error: {
          code: "AGENT_INVALID_REQUEST",
          message: "Agent 请求参数不合法。",
          correlationId,
          details: { issues: error.issues },
        },
      },
      correlationId,
      { status: 400 },
    );
  }

  console.error("[agent-api]", correlationId, error);
  return agentJsonResponse(
    {
      error: {
        code: "AGENT_INTERNAL_ERROR",
        message: "Agent 服务暂时不可用，请稍后重试。",
        correlationId,
      },
    },
    correlationId,
    { status: 500 },
  );
}

export async function readAgentJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function getAgentPersistence() {
  const database = getDatabase();
  return {
    // 聚合快照需要 REPEATABLE READ，但必须固定到独占 PoolClient，不能依赖
    // Drizzle 在热更新 bundle 之间进行不稳定的 Pool instanceof 判断。Agent
    // 原子写事务也共用同一 runner，保证 checkpoint、ChangeSet 和 Run 终态
    // 在同一连接内获得 read-your-writes 语义。
    store: new AgentStore(database, {
      transaction: runDatabaseTransaction,
    }),
    repository: new DatabaseProjectRepository(database),
    history: new ProjectHistoryService(database),
  };
}
