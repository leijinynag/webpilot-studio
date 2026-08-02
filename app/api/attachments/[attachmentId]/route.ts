import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  getOwnedAttachment,
  softDeleteAttachment,
} from "@/domains/image/service";
import { imageApiErrorResponse } from "@/infrastructure/http/image-api";
import { getPrivateBlobStore } from "@/infrastructure/blob/private-store";

const paramsSchema = z.object({ attachmentId: z.uuid() }).strict();

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { attachmentId } = paramsSchema.parse(await context.params);
    const attachment = await getOwnedAttachment({ ownerId, attachmentId });
    const blob = await getPrivateBlobStore().get(attachment.blobPathname);

    if (!blob) {
      return NextResponse.json(
        {
          error: {
            code: "IMAGE_BLOB_NOT_FOUND",
            message: "图片对象不存在或尚未完成写入。",
          },
        },
        { status: 404 },
      );
    }

    const headers = createImageResponseHeaders({
      contentType: blob.contentType ?? attachment.mimeType,
      contentLength: blob.size ?? attachment.byteLength,
      filename: attachment.originalFilename,
    });
    return new NextResponse(blob.stream, { headers });
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ attachmentId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { attachmentId } = paramsSchema.parse(await context.params);
    await softDeleteAttachment({ ownerId, attachmentId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}

function createImageResponseHeaders(input: {
  contentType: string;
  contentLength: number | null;
  filename: string;
}) {
  const headers = new Headers({
    "Content-Type": input.contentType,
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(input.filename)}`,
    "X-Content-Type-Options": "nosniff",
  });
  if (input.contentLength !== null) {
    headers.set("Content-Length", String(input.contentLength));
  }
  return headers;
}
