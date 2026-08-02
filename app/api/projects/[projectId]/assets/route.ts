import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { listOwnedAssets } from "@/domains/image/service";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import { imageApiErrorResponse } from "@/infrastructure/http/image-api";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const assets = await listOwnedAssets({ ownerId, projectId });
    return NextResponse.json(
      { assets },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    return imageApiErrorResponse(error);
  }
}
