import "server-only";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  codeCompletionRequestSchema,
  codeCompletionResponseSchema,
  codeCompletionStatusSchema,
} from "@/domains/code-completion/types";
import { ProjectError, PROJECT_ERROR_CODES } from "@/domains/project/errors";
import { projectIdParamsSchema } from "@/domains/project/api-schemas";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  readAgentJsonBody,
} from "@/infrastructure/http/agent-api";
import { getProjectRepository } from "@/infrastructure/http/project-api";
import { createCodeCompletionRuntime } from "@/infrastructure/code-completion/runtime";
import { getCodeCompletionModelStatus } from "@/infrastructure/agent/provider-factory";

export const runtime = "nodejs";

/**
 * 补全请求是编辑器的短生命周期请求，运行时实例必须在模块级复用。
 * 这样同一个 Node 实例中的 LRU 与 in-flight 去重才能跨请求生效；
 * 运行时内部仍会在真正需要时读取服务端 Provider 配置，不会在构建阶段
 * 因为缺少 API Key 让整个 Next.js 构建失败。
 */
const codeCompletionRuntime = createCodeCompletionRuntime();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);

    // 状态查询仍校验项目归属，避免它成为一个与项目无关的部署探测接口。
    await getProjectRepository().describe({ ownerId, projectId });

    return agentJsonResponse(
      codeCompletionStatusSchema.parse(getCodeCompletionModelStatus()),
      correlationId,
    );
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = projectIdParamsSchema.parse(await context.params);
    const body = codeCompletionRequestSchema.parse(
      await readAgentJsonBody(request),
    );
    const repository = getProjectRepository();
    const project = await repository.describe({ ownerId, projectId });

    if (project.storageKind === "database") {
      assertProjectRevision(project.revision, body.projectRevision);
    }

    const sourceFiles =
      project.storageKind === "database"
        ? (await repository.listFiles({ ownerId, projectId })).map((file) => ({
            path: file.path,
            content: file.content,
          }))
        : getBrowserGitSourceFiles(body);

    const response = await codeCompletionRuntime.complete({
      ownerId,
      request: body,
      sourceFiles,
      currentProjectRevision:
        project.storageKind === "database" ? project.revision : undefined,
      signal: request.signal,
    });

    // 最终响应再过一层 schema，避免 Provider 或未来运行时扩展意外把
    // 内部字段泄露给浏览器；补全接口只返回插入文本和诊断字段。
    return agentJsonResponse(
      codeCompletionResponseSchema.parse(response),
      correlationId,
    );
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}

function assertProjectRevision(
  actualRevision: number,
  expectedRevision: number,
) {
  if (actualRevision === expectedRevision) {
    return;
  }

  throw new ProjectError(
    PROJECT_ERROR_CODES.revisionConflict,
    "项目内容已发生变化，请刷新编辑器后重试补全。",
    409,
    {
      actualRevision,
      expectedRevision,
    },
  );
}

function getBrowserGitSourceFiles(
  body: ReturnType<typeof codeCompletionRequestSchema.parse>,
) {
  const files = body.browserContext?.files;
  if (!files) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.invalidRequest,
      "Browser Git 补全缺少浏览器端文件上下文。",
      400,
    );
  }

  if (!files.some((file) => file.path === body.path)) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.invalidRequest,
      "Browser Git 补全上下文中缺少当前文件。",
      400,
    );
  }

  return files;
}
