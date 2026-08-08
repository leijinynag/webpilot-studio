import { NextResponse } from "next/server";
import { z } from "zod";

import {
  assertAttachmentUploadEnabled,
  createImageAttachments,
  listOwnedAttachments,
} from "@/domains/image/service";
import { ImageError, IMAGE_ERROR_CODES } from "@/domains/image/errors";
import { requireRequestOwner } from "@/domains/auth/request-owner";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import { imageApiErrorResponse } from "@/infrastructure/http/image-api";

const querySchema = z
  .object({
    conversationId: z.uuid().optional(),
  })
  .strict();

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const url = new URL(request.url);
    const query = querySchema.parse({
      conversationId: url.searchParams.get("conversationId") ?? undefined,
    });
    const attachments = await listOwnedAttachments({
      ownerId,
      projectId,
      conversationId: query.conversationId,
    });

    return NextResponse.json(
      { attachments },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    assertAttachmentUploadEnabled();
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const formData = await request.formData();
    const files = formData
      .getAll("files")
      .concat(formData.getAll("file"))
      .filter((value): value is File => value instanceof File);
    const conversationIdValue = formData.get("conversationId");
    const conversationId = z
      .uuid()
      .optional()
      .parse(
        typeof conversationIdValue === "string"
          ? conversationIdValue || undefined
          : undefined,
      );

    if (files.length === 0) {
      throw new ImageError(
        IMAGE_ERROR_CODES.fileRequired,
        "请求中没有找到图片文件。",
      );
    }

    const attachments = await createImageAttachments({
      ownerId,
      projectId,
      conversationId,
      request,
      files,
    });

    return NextResponse.json({ attachments }, { status: 201 });
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}
