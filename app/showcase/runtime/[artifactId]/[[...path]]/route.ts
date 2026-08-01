import { NextResponse } from "next/server";
import { z } from "zod";

import { serverEnv } from "@/infrastructure/env/server";
import { normalizeArtifactPath } from "@/infrastructure/showcase/artifact";
import { readPublishedArtifactFile } from "@/infrastructure/showcase/repository";

const paramsSchema = z
  .object({
    artifactId: z.uuid(),
    path: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Showcase Runtime 只做静态文件读取，不执行主站 Agent、数据库写入或用户会话。
 * 入口和每个资源都会重新检查 artifact 状态，因此撤销后不会继续新增访问。
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: {
    params: Promise<{ artifactId: string; path?: string[] }>;
  },
) {
  try {
    const expectedOrigin = serverEnv.SHOWCASE_ORIGIN?.replace(/\/$/, "");
    if (expectedOrigin && new URL(request.url).origin !== expectedOrigin) {
      return runtimeError(
        "SHOWCASE_RUNTIME_ORIGIN_MISMATCH",
        "该 Runtime 仅允许通过独立 Showcase 域名访问。",
        404,
      );
    }

    const params = paramsSchema.parse(await context.params);
    const rawPath = params.path?.join("/") || "index.html";
    const path = normalizeArtifactPath(rawPath);
    const file = await readPublishedArtifactFile(params.artifactId, path);

    if (!file) {
      return runtimeError("SHOWCASE_ARTIFACT_NOT_FOUND", "资源不存在。", 404);
    }

    return new NextResponse(file.stream, {
      headers: {
        "Cache-Control": file.isEntry
          ? "no-store, max-age=0"
          : "public, max-age=31536000, immutable",
        "Content-Length": String(file.size),
        "Content-Security-Policy": buildRuntimeCsp(),
        "Content-Type": file.contentType,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return runtimeError("SHOWCASE_INVALID_PATH", "资源路径不合法。", 400);
    }

    if (
      error instanceof Error &&
      error.message.includes("项目文件路径不合法")
    ) {
      return runtimeError("SHOWCASE_INVALID_PATH", "资源路径不合法。", 400);
    }

    console.error("[showcase-runtime]", error);
    return runtimeError(
      "SHOWCASE_RUNTIME_ERROR",
      "预览资源暂时不可用，请稍后重试。",
      500,
    );
  }
}

function buildRuntimeCsp(): string {
  const parentOrigin = serverEnv.SHOWCASE_PARENT_ORIGIN?.replace(/\/$/, "");

  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors 'self'${parentOrigin ? ` ${parentOrigin}` : ""}`,
  ].join("; ");
}

function runtimeError(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
