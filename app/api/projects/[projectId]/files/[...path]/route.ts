import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
} from "@/infrastructure/http/project-api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; path: string[] }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const params = await context.params;
    const { projectId } = projectIdParamsSchema.parse(params);
    const repository = getProjectRepository();
    const file = await repository.readFile({
      ownerId,
      projectId,
      path: params.path.join("/"),
    });

    return NextResponse.json({ file });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
