import { NextResponse } from "next/server";
import { z } from "zod";

import { isShowcaseAdminRequest } from "@/infrastructure/showcase/admin";

const artifactFileSchema = z.object({
  path: z.string().trim().min(1).max(512),
  byteLength: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const showcaseManifestSchema = z
  .object({
    format: z.literal("webpilot-showcase-artifact-v1"),
    entryPath: z.literal("index.html"),
    files: z.array(artifactFileSchema).min(1).max(500),
    totalBytes: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export const showcasePublishRequestSchema = z
  .object({
    caseId: z.uuid().optional(),
    projectId: z.uuid().nullable().optional(),
    title: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().max(2_000).nullable().optional(),
    coverUrl: z.url().nullable().optional(),
    sortOrder: z.number().int().min(-100_000).max(100_000).optional(),
    sourceRevision: z.number().int().nonnegative(),
    manifest: showcaseManifestSchema,
    files: z
      .array(
        z.object({
          path: z.string().trim().min(1).max(512),
          hash: z.string().regex(/^[a-f0-9]{64}$/i),
          contentBase64: z
            .string()
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
            .max(16_000_000),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();

export function requireShowcaseAdmin(request: Request): NextResponse | null {
  if (isShowcaseAdminRequest(request)) {
    return null;
  }

  return NextResponse.json(
    {
      error: {
        code: "SHOWCASE_ADMIN_UNAUTHORIZED",
        message: "Showcase 管理权限校验失败。",
      },
    },
    { status: 401 },
  );
}

export function showcaseApiError(
  error: unknown,
  fallbackMessage = "Showcase 服务暂时不可用，请稍后重试。",
): NextResponse {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "请求参数不合法。",
          details: { issues: error.issues },
        },
      },
      { status: 400 },
    );
  }

  if (error instanceof Error) {
    if (
      error.message === "Showcase 需要配置 BLOB_READ_WRITE_TOKEN。" ||
      error.message === "数据库功能需要配置 DATABASE_URL。"
    ) {
      return NextResponse.json(
        {
          error: {
            code: "SHOWCASE_STORAGE_UNAVAILABLE",
            message: "Showcase 存储暂不可用，请稍后重试。",
          },
        },
        { status: 503 },
      );
    }

    console.error("[showcase-api]", error);
  } else {
    console.error("[showcase-api]", error);
  }

  return NextResponse.json(
    {
      error: {
        code: "SHOWCASE_INTERNAL_ERROR",
        message: fallbackMessage,
      },
    },
    { status: 500 },
  );
}
