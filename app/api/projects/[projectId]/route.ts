import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
} from "@/infrastructure/http/project-api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const repository = getProjectRepository();
    const project = await repository.describe({ ownerId, projectId });

    return NextResponse.json({ project });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
