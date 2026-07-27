import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
} from "@/infrastructure/http/project-api";

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const repository = getProjectRepository();
    await repository.restoreProject({ ownerId, projectId });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
