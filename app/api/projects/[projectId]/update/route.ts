import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  projectIdParamsSchema,
  updateProjectRequestSchema,
} from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
  readJsonBody,
} from "@/infrastructure/http/project-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const body = updateProjectRequestSchema.parse(await readJsonBody(request));
    const repository = getProjectRepository();
    const result = await repository.renameProject({
      ownerId,
      projectId,
      name: body.name,
      expectedRevision: body.expectedRevision,
    });

    return NextResponse.json({ result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
