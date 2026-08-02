import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { getOwnedAsset, softDeleteAsset } from "@/domains/image/service";
import { getPrivateBlobStore } from "@/infrastructure/blob/private-store";
import { imageApiErrorResponse } from "@/infrastructure/http/image-api";

const paramsSchema = z.object({ assetId: z.uuid() }).strict();

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { assetId } = paramsSchema.parse(await context.params);
    const asset = await getOwnedAsset({ ownerId, assetId });
    const blob = await getPrivateBlobStore().get(asset.blobPathname);

    if (!blob) {
      return NextResponse.json(
        {
          error: {
            code: "IMAGE_BLOB_NOT_FOUND",
            message: "资产对象不存在或尚未完成写入。",
          },
        },
        { status: 404 },
      );
    }

    const headers = new Headers({
      "Content-Type": blob.contentType ?? asset.mimeType,
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(asset.originalFilename ?? asset.id)}`,
      "X-Content-Type-Options": "nosniff",
    });
    if (blob.size !== null) {
      headers.set("Content-Length", String(blob.size));
    }
    return new NextResponse(blob.stream, { headers });
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ assetId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { assetId } = paramsSchema.parse(await context.params);
    await softDeleteAsset({ ownerId, assetId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}
