import { NextResponse } from "next/server";
import { z } from "zod";

import { verifySignedAssetRequest } from "@/domains/image/asset-url";
import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import { getActiveAssetForSignedAccess } from "@/domains/image/service";
import { getPrivateBlobStore } from "@/infrastructure/blob/private-store";
import { imageApiErrorResponse } from "@/infrastructure/http/image-api";

const paramsSchema = z.object({ assetId: z.uuid() }).strict();
const querySchema = z
  .object({
    projectId: z.uuid(),
    exp: z.coerce.number().int().positive(),
    sig: z.string().min(1).max(200),
  })
  .strict();

export const runtime = "nodejs";

/**
 * Preview 使用的私有资产出口。
 *
 * 这个路由不读取匿名 Cookie，而是把 owner、project 和过期时间全部放进
 * HMAC 校验。这样跨 origin 的 Preview iframe 可以加载图片，同时无法把
 * 一个 owner 的签名拿去访问另一个项目或已删除资产。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  try {
    const { assetId } = paramsSchema.parse(await context.params);
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );

    // 先依据 assetId 和 projectId 找到数据库事实，再用该记录里的 ownerId
    // 参与签名校验。客户端无法自行提交一个可被信任的 ownerId。
    const asset = await getActiveAssetForSignedAccess({
      assetId,
      projectId: query.projectId,
    });
    if (
      !verifySignedAssetRequest({
        assetId: asset.id,
        projectId: asset.projectId,
        ownerId: asset.ownerId,
        expiresAt: query.exp,
        signature: query.sig,
      })
    ) {
      throw new ImageError(
        IMAGE_ERROR_CODES.assetNotFound,
        "资产签名无效或已过期。",
        404,
      );
    }

    const blob = await getPrivateBlobStore().get(asset.blobPathname);
    if (!blob) {
      throw new ImageError(
        IMAGE_ERROR_CODES.blobUnavailable,
        "资产对象不存在或尚未完成写入。",
        404,
      );
    }

    const headers = new Headers({
      "Content-Type": blob.contentType ?? asset.mimeType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.originalFilename ?? asset.id)}`,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "private, no-store, max-age=0",
    });
    if (blob.size !== null) {
      headers.set("Content-Length", String(blob.size));
    }

    return new NextResponse(blob.stream, { headers });
  } catch (error) {
    // 对签名访问统一隐藏“资产不存在”和“签名不匹配”的区别，避免枚举
    // 其他 owner 的资产 ID。
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: {
            code: IMAGE_ERROR_CODES.assetNotFound,
            message: "资产不存在或访问链接无效。",
          },
        },
        { status: 404 },
      );
    }
    if (error instanceof ImageError && error.code === IMAGE_ERROR_CODES.assetNotFound) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: 404 },
      );
    }
    return imageApiErrorResponse(error);
  }
}
