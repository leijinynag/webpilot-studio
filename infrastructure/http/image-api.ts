import { NextResponse } from "next/server";
import { z } from "zod";

import { isImageError } from "@/domains/image/errors";
import { isQuotaError } from "@/infrastructure/quota/errors";

export function imageApiErrorResponse(error: unknown): NextResponse {
  if (isImageError(error) || isQuotaError(error)) {
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
          code: "IMAGE_INVALID_REQUEST",
          message: "图片请求参数不合法。",
          details: { issues: error.issues },
        },
      },
      { status: 400 },
    );
  }

  if (
    error instanceof Error &&
    (error.message === "数据库功能需要配置 DATABASE_URL。" ||
      error.message === "图片存储尚未配置 BLOB_READ_WRITE_TOKEN。")
  ) {
    return NextResponse.json(
      {
        error: {
          code: "IMAGE_STORAGE_UNAVAILABLE",
          message: "图片存储暂不可用，请稍后重试。",
        },
      },
      { status: 503 },
    );
  }

  console.error("[image-api]", error);
  return NextResponse.json(
    {
      error: {
        code: "IMAGE_INTERNAL_ERROR",
        message: "图片服务暂时不可用，请稍后重试。",
      },
    },
    { status: 500 },
  );
}
