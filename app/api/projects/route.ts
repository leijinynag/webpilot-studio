import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import { createProjectRequestSchema } from "@/domains/project/api-schemas";
import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";
import { flattenProjectTemplate } from "@/domains/project/template";
import {
  apiErrorResponse,
  getProjectRepository,
  readJsonBody,
} from "@/infrastructure/http/project-api";
import { WEBPILOT_RSBUILD_TEMPLATE } from "@/infrastructure/webcontainer/project-template";

const listProjectsQuerySchema = z.object({
  includeDeleted: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export async function GET(request: Request) {
  try {
    const ownerId = await requireRequestOwner();
    const url = new URL(request.url);
    const query = listProjectsQuerySchema.parse({
      includeDeleted: url.searchParams.get("includeDeleted") ?? undefined,
    });
    const repository = getProjectRepository();
    const projects = await repository.listProjects({
      ownerId,
      includeDeleted: query.includeDeleted,
    });

    return NextResponse.json({ projects });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = await requireRequestOwner();
    const body = createProjectRequestSchema.parse(await readJsonBody(request));

    if (body.storageKind === "browser_git") {
      throw new ProjectError(
        PROJECT_ERROR_CODES.storageUnavailable,
        "Browser Git 尚未接入持久化链路。",
        409,
      );
    }

    const repository = getProjectRepository();
    const project = await repository.createProject({
      ownerId,
      name: body.name,
      storageKind: "database",
      // 空项目不写入任何示例源码。只有调用方明确选择 rsbuild 时才展开模板，
      // 从而让“Blank”与服务端持久化语义保持一致。
      initialFiles:
        body.template === "rsbuild"
          ? flattenProjectTemplate(WEBPILOT_RSBUILD_TEMPLATE)
          : [],
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
