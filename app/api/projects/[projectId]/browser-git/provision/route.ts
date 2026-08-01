import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  browserGitProvisionRequestSchema,
  projectIdParamsSchema,
} from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
  readJsonBody,
} from "@/infrastructure/http/project-api";

/**
 * Browser Git 首次创建许可由服务端项目索引一次性签发。
 * 该 API 不接收源码，也不参与本地 Git 操作；首次成功 claim 会附带创建项目时
 * 冻结的初始快照，供当前页面写入 IndexedDB，后续 claim 不再返回源码。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const body = browserGitProvisionRequestSchema.parse(
      await readJsonBody(request),
    );
    const repository = getProjectRepository();

    if (body.action === "claim") {
      const provision = await repository.claimBrowserGitProvision({
        ownerId,
        projectId,
      });
      return NextResponse.json(provision);
    }

    await repository.markBrowserGitUnavailable({ ownerId, projectId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
