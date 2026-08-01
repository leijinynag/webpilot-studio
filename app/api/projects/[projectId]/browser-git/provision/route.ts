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
 * 该 API 不接收源码，也不参与本地 Git 操作，只维护创建状态和数据丢失状态。
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
