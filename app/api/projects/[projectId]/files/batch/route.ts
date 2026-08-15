import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  batchFileMutationRequestSchema,
  projectIdParamsSchema,
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
    const body = batchFileMutationRequestSchema.parse(
      await readJsonBody(request),
    );
    const repository = getProjectRepository();

    // expectedRevision 绑定用户审查时看到的 Runtime Diff。审查期间若 Repository
    // 已经变化，底层 CAS 会拒绝整个批次，不能让部分文件偷偷落入更新后的 revision。
    const result = await repository.batchMutateFiles({
      ownerId,
      projectId,
      expectedRevision: body.expectedRevision,
      mutations: body.mutations,
    });

    return NextResponse.json({ result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
