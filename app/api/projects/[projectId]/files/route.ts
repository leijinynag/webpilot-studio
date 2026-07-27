import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  fileMutationRequestSchema,
  projectIdParamsSchema,
  renameFileRequestSchema,
  writeFileRequestSchema,
} from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
  readJsonBody,
} from "@/infrastructure/http/project-api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const repository = getProjectRepository();
    const files = await repository.listFiles({ ownerId, projectId });

    return NextResponse.json({ files });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const body = writeFileRequestSchema.parse(await readJsonBody(request));
    const repository = getProjectRepository();
    const result = await repository.writeFile({
      ownerId,
      projectId,
      path: body.path,
      content: body.content,
      expectedRevision: body.expectedRevision,
    });
    const file = await repository.readFile({
      ownerId,
      projectId,
      path: body.path,
    });

    return NextResponse.json({ file, result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const url = new URL(request.url);
    const body = fileMutationRequestSchema.parse({
      path: url.searchParams.get("path"),
      expectedRevision: url.searchParams.get("expectedRevision"),
    });
    const repository = getProjectRepository();
    const result = await repository.deleteFile({
      ownerId,
      projectId,
      path: body.path,
      expectedRevision: body.expectedRevision,
    });

    return NextResponse.json({ result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const body = renameFileRequestSchema.parse(await readJsonBody(request));
    const repository = getProjectRepository();
    const result = await repository.renameFile({
      ownerId,
      projectId,
      fromPath: body.fromPath,
      toPath: body.toPath,
      expectedRevision: body.expectedRevision,
    });
    const file = await repository.readFile({
      ownerId,
      projectId,
      path: body.toPath,
    });

    return NextResponse.json({ file, result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
