import "server-only";

import { readRequestOwner } from "@/domains/auth/request-owner";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import { isProjectError } from "@/domains/project/errors";
import type {
  ProjectDescription,
  ProjectFileSnapshot,
} from "@/domains/project/types";
import { getProjectRepository } from "@/infrastructure/http/project-api";

export type OwnedProjectPageData = {
  project: ProjectDescription;
  files: ProjectFileSnapshot[];
};

/**
 * 动态项目页面与 API 共用同一 Repository 和 owner 边界。
 * 这里不创建匿名身份：页面请求应已由 proxy 建立 Cookie，Server Component 只负责读取。
 */
export async function loadOwnedProject(
  rawProjectId: string,
  options: { includeFiles?: boolean } = {},
): Promise<OwnedProjectPageData | null> {
  const parsedParams = projectIdParamsSchema.safeParse({
    projectId: rawProjectId,
  });
  const ownerId = await readRequestOwner();

  if (!parsedParams.success || !ownerId) {
    return null;
  }

  const repository = getProjectRepository();

  try {
    const project = await repository.describe({
      ownerId,
      projectId: parsedParams.data.projectId,
    });
    const files =
      options.includeFiles && project.storageKind === "database"
        ? await repository.listFiles({
            ownerId,
            projectId: parsedParams.data.projectId,
          })
        : [];

    return { project, files };
  } catch (error) {
    // 只有业务层明确给出的 404 才进入 not-found；
    // 数据库连接等基础设施故障继续抛出，由全局错误页和监控承接。
    if (isProjectError(error) && error.status === 404) {
      return null;
    }

    throw error;
  }
}
