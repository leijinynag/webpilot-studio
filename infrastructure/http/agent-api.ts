import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { isAgentError } from "@/domains/agent/errors";
import { AgentStore } from "@/domains/agent/store";
import { isProjectError } from "@/domains/project/errors";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import { getDatabase } from "@/infrastructure/db/client";

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
  return response;
}

export function agentApiErrorResponse(
  error: unknown,
  correlationId: string,
): NextResponse<ApiErrorBody> {
  if (isAgentError(error) || isProjectError(error)) {
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
    store: new AgentStore(database),
    repository: new DatabaseProjectRepository(database),
  };
}
