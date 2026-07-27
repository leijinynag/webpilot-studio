import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import { ProjectError, PROJECT_ERROR_CODES } from "@/domains/project/errors";
import {
  apiErrorResponse,
  getProjectRepository,
} from "@/infrastructure/http/project-api";

const searchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  maxResults: z.coerce.number().int().positive().max(100).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const url = new URL(request.url);
    const query = searchQuerySchema.parse({
      query: url.searchParams.get("query"),
      maxResults: url.searchParams.get("maxResults") ?? undefined,
    });
    const repository = getProjectRepository();
    const matches = await repository.searchText({
      ownerId,
      projectId,
      query: query.query,
      options: { maxResults: query.maxResults },
    });

    return NextResponse.json({ matches });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiErrorResponse(
        new ProjectError(
          PROJECT_ERROR_CODES.invalidRequest,
          "搜索参数不合法。",
          400,
          { issues: error.issues },
        ),
      );
    }

    return apiErrorResponse(error);
  }
}
