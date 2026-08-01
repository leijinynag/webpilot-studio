import { NextResponse } from "next/server";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  browserGitMigrationRequestSchema,
  projectIdParamsSchema,
} from "@/domains/project/api-schemas";
import {
  apiErrorResponse,
  getProjectRepository,
  readJsonBody,
} from "@/infrastructure/http/project-api";

/**
 * Database -> Browser Git 迁移只通过短期会话交换校验信息。
 *
 * prepare 会返回一次完整源码快照；candidate 和正式 Git Repository 都在
 * 当前浏览器中创建，服务端不会接收 Git 对象。finalize 是唯一会切换
 * storageKind 的动作，并且会再次执行 revision CAS。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const body = browserGitMigrationRequestSchema.parse(
      await readJsonBody(request),
    );
    const repository = getProjectRepository();

    if (body.action === "prepare") {
      const migration = await repository.prepareBrowserGitMigration({
        ownerId,
        projectId,
      });
      return NextResponse.json({ migration });
    }

    if (body.action === "cancel") {
      await repository.cancelBrowserGitMigration({
        ownerId,
        projectId,
        sessionId: body.sessionId,
        token: body.token,
      });
      return NextResponse.json({ ok: true });
    }

    const result = await repository.finalizeBrowserGitMigration({
      ownerId,
      projectId,
      sessionId: body.sessionId,
      token: body.token,
      candidateRepositoryId: body.candidateRepositoryId,
      manifestHash: body.manifestHash,
      head: body.head,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
