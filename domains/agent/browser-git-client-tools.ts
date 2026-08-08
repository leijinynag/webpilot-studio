"use client";

import { z } from "zod";

import type {
  BrowserRepositoryClientToolRequest,
  BrowserRepositoryToolResult,
} from "@/domains/agent/client-tools";
import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import {
  FILE_TOOL_NAMES,
  GIT_TOOL_NAMES,
} from "@/domains/agent/tool-contracts";
import { isProjectError, PROJECT_ERROR_CODES } from "@/domains/project/errors";
import type { BrowserGitProjectRepository } from "@/domains/project/browser-git-repository";

/**
 * Browser Repository 工具执行器只存在于客户端。
 *
 * 它把统一 Agent Tool 协议翻译为 BrowserGitProjectRepository 调用，并统一
 * 生成可提交给服务端的成功/失败 envelope。服务端只审计结果，不接触源码。
 */
export async function executeBrowserRepositoryClientTool(input: {
  repository: BrowserGitProjectRepository;
  request: BrowserRepositoryClientToolRequest;
}): Promise<BrowserRepositoryToolResult> {
  const { repository, request } = input;

  try {
    switch (request.toolName) {
      case FILE_TOOL_NAMES.listFiles: {
        const files = await repository.listFiles();
        return success(request, request.revision, {
          files: files.map(({ path, byteLength, hash, updatedAt }) => ({
            path,
            byteLength,
            hash,
            updatedAt,
          })),
        });
      }
      case FILE_TOOL_NAMES.searchText: {
        const matches = await repository.searchText({
          query: request.arguments.query,
          options: { maxResults: request.arguments.maxResults },
        });
        return success(request, request.revision, { matches });
      }
      case FILE_TOOL_NAMES.readFile: {
        const file = await repository.readFile({
          path: request.arguments.path,
        });
        return success(request, request.revision, { file });
      }
      case FILE_TOOL_NAMES.writeFile: {
        const existing = await readOptionalFile(
          repository,
          request.arguments.path,
        );
        if (existing && !request.readBeforeMutation) {
          return toolReadRequired(request, request.arguments.path);
        }
        const mutation = await repository.writeFile(request.arguments);
        return success(request, mutation.revision, {
          changedPaths: mutation.changedPaths,
          operation: existing ? "update" : "create",
        });
      }
      case FILE_TOOL_NAMES.deleteFile: {
        const mutation = await repository.deleteFile(request.arguments);
        return success(request, mutation.revision, {
          changedPaths: mutation.changedPaths,
          operation: "delete",
        });
      }
      case FILE_TOOL_NAMES.renameFile: {
        const mutation = await repository.renameFile(request.arguments);
        return success(request, mutation.revision, {
          changedPaths: mutation.changedPaths,
          operation: "rename",
        });
      }
      case GIT_TOOL_NAMES.status: {
        const state = await repository.getGitState();
        return success(request, request.revision, {
          branch: state.branch,
          head: state.head,
          files: state.files,
          clean: state.files.length === 0,
        });
      }
      case GIT_TOOL_NAMES.log: {
        const state = await repository.getGitState();
        return success(request, request.revision, {
          commits: state.commits.slice(0, request.arguments.maxCount),
        });
      }
      case GIT_TOOL_NAMES.currentBranch: {
        const state = await repository.getGitState();
        return success(request, request.revision, {
          branch: state.branch,
          head: state.head,
        });
      }
      case GIT_TOOL_NAMES.stage: {
        const state = await repository.stage(request.arguments.paths);
        return success(request, request.revision, {
          branch: state.branch,
          files: state.files,
        });
      }
      case GIT_TOOL_NAMES.unstage: {
        const state = await repository.unstage(request.arguments.paths);
        return success(request, request.revision, {
          branch: state.branch,
          files: state.files,
        });
      }
      case GIT_TOOL_NAMES.commit: {
        // author 来自服务端冻结的原始用户意图。这里绝不读取 Source Control
        // 表单默认值，也不根据浏览器环境生成身份。
        const result = await repository.commit({
          message: request.arguments.message,
          authorName: request.author.name,
          authorEmail: request.author.email,
        });
        return success(request, request.revision, {
          oid: result.oid,
          branch: result.state.branch,
          head: result.state.head,
          commits: result.state.commits,
        });
      }
    }
  } catch (error) {
    return failure(request, error);
  }
}

/**
 * 仓库尚未初始化或本地数据已经丢失时，页面仍需向服务端提交结构化失败。
 * 这样 Run 能离开 awaiting_client_tool，并把失败事实作为 tool_result 交给模型。
 */
export function createBrowserRepositoryToolFailure(
  request: BrowserRepositoryClientToolRequest,
  error: unknown,
): BrowserRepositoryToolResult {
  return failure(request, error);
}

function toolReadRequired(
  request: BrowserRepositoryClientToolRequest,
  path: string,
): BrowserRepositoryToolResult {
  return {
    ok: false,
    toolName: request.toolName,
    revision: request.revision,
    conflict: false,
    error: {
      code: AGENT_ERROR_CODES.toolReadRequired,
      message: "修改已有文件前必须在同一 Run 和 revision 下调用 read_file。",
      details: { path, revision: request.revision },
    },
  } as BrowserRepositoryToolResult;
}

function success(
  request: BrowserRepositoryClientToolRequest,
  revision: number,
  data: Record<string, unknown>,
): BrowserRepositoryToolResult {
  return {
    ok: true,
    toolName: request.toolName,
    revision,
    data,
  } as BrowserRepositoryToolResult;
}

function failure(
  request: BrowserRepositoryClientToolRequest,
  error: unknown,
): BrowserRepositoryToolResult {
  if (isProjectError(error)) {
    const conflict = error.code === PROJECT_ERROR_CODES.revisionConflict;
    return {
      ok: false,
      toolName: request.toolName,
      revision: request.revision,
      conflict,
      error: {
        code: conflict ? AGENT_ERROR_CODES.revisionConflict : error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    } as BrowserRepositoryToolResult;
  }

  if (error instanceof z.ZodError) {
    return {
      ok: false,
      toolName: request.toolName,
      revision: request.revision,
      conflict: false,
      error: {
        code: AGENT_ERROR_CODES.toolInvalidArguments,
        message: `工具 ${request.toolName} 的参数不合法。`,
        details: { issues: error.issues },
      },
    } as BrowserRepositoryToolResult;
  }

  return {
    ok: false,
    toolName: request.toolName,
    revision: request.revision,
    conflict: false,
    error: {
      code: "AGENT_TOOL_EXECUTION_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "Browser Repository 工具执行失败。",
    },
  } as BrowserRepositoryToolResult;
}

async function readOptionalFile(
  repository: BrowserGitProjectRepository,
  path: string,
) {
  try {
    return await repository.readFile({ path });
  } catch (error) {
    if (
      isProjectError(error) &&
      error.code === PROJECT_ERROR_CODES.fileNotFound
    ) {
      return null;
    }
    throw error;
  }
}
