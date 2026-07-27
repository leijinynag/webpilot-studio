import { NextResponse } from "next/server";
import { z } from "zod";

import {
  isProjectError,
  PROJECT_ERROR_CODES,
  ProjectError,
} from "@/domains/project/errors";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import { getDatabase } from "@/infrastructure/db/client";

type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

/**
 * API 统一只返回一个 error envelope，客户端可以稳定依赖 code 做分支，
 * 而不是解析容易变化的中文提示。
 */
export function apiErrorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (isProjectError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }

  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: PROJECT_ERROR_CODES.invalidRequest,
          message: "请求参数不合法。",
          details: { issues: error.issues },
        },
      },
      { status: 400 },
    );
  }

  if (
    error instanceof Error &&
    error.message === "数据库功能需要配置 DATABASE_URL。"
  ) {
    return NextResponse.json(
      {
        error: {
          code: PROJECT_ERROR_CODES.storageUnavailable,
          message: "项目存储暂不可用，请稍后重试。",
        },
      },
      { status: 503 },
    );
  }

  console.error("[project-api]", error);

  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后重试。",
      },
    },
    { status: 500 },
  );
}

export function requestBodyError(message: string): ProjectError {
  return new ProjectError(PROJECT_ERROR_CODES.invalidRequest, message, 400);
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw requestBodyError("请求体必须是合法 JSON。");
  }
}

export function getProjectRepository() {
  return new DatabaseProjectRepository(getDatabase());
}
