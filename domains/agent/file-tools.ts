import { isDeepStrictEqual } from "node:util";

import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { z } from "zod";

import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { AgentStore } from "@/domains/agent/store";
import {
  FILE_TOOL_NAMES,
  type FileToolName,
} from "@/domains/agent/tool-contracts";
import type { AgentRunRecord } from "@/domains/agent/types";
import { isProjectError, PROJECT_ERROR_CODES } from "@/domains/project/errors";
import { assertValidProjectPath } from "@/domains/project/path";
import type { ProjectRepository } from "@/domains/project/repository";

const projectPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform(assertValidProjectPath);
const expectedRevisionSchema = z.number().int().nonnegative();

export const FILE_TOOL_SCHEMAS = {
  [FILE_TOOL_NAMES.listFiles]: z.object({}).strict(),
  [FILE_TOOL_NAMES.searchText]: z
    .object({
      query: z.string().trim().min(1).max(200),
      maxResults: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  [FILE_TOOL_NAMES.readFile]: z.object({ path: projectPathSchema }).strict(),
  [FILE_TOOL_NAMES.writeFile]: z
    .object({
      path: projectPathSchema,
      content: z.string().max(1_000_000),
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
  [FILE_TOOL_NAMES.deleteFile]: z
    .object({
      path: projectPathSchema,
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
  [FILE_TOOL_NAMES.renameFile]: z
    .object({
      fromPath: projectPathSchema,
      toPath: projectPathSchema,
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
} as const;

export type FileToolSuccessEnvelope = {
  ok: true;
  toolName: FileToolName;
  revision: number;
  data: Record<string, unknown>;
};

export type FileToolFailureEnvelope = {
  ok: false;
  toolName: FileToolName;
  conflict: boolean;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type FileToolResultEnvelope =
  FileToolSuccessEnvelope | FileToolFailureEnvelope;

type AgentStoreLike = Pick<
  AgentStore<PgQueryResultHKT>,
  | "registerToolInvocation"
  | "markToolInvocationRunning"
  | "completeToolInvocation"
  | "findSuccessfulRead"
  | "getRun"
>;

export class FileToolExecutor {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly store: AgentStoreLike,
  ) {}

  /**
   * 单次调用只执行一个工具，Agent Loop 必须等待结果后才能进入下一次 mutation。
   * ledger 在参数校验与所有 Repository 副作用前创建，失败也会留下可审计事实。
   */
  async execute(input: {
    run: AgentRunRecord;
    toolCallId: string;
    toolName: string;
    argumentsJson: unknown;
  }): Promise<FileToolResultEnvelope> {
    const toolName = assertFileToolName(input.toolName);
    const ledgerArguments = toLedgerArguments(input.argumentsJson);
    const registration = await this.store.registerToolInvocation({
      runId: input.run.id,
      toolCallId: input.toolCallId,
      toolName,
      executionDomain: "server",
      argumentsJson: ledgerArguments,
      idempotencyKey: `${input.run.id}:${input.toolCallId}`,
      revisionBefore: input.run.currentRevision,
    });

    if (!registration.created) {
      if (
        registration.invocation.toolName !== toolName ||
        !isDeepStrictEqual(
          registration.invocation.argumentsJson,
          ledgerArguments,
        )
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          "重复的 toolCallId 携带了不同的工具名称或参数。",
          409,
          { toolCallId: input.toolCallId },
        );
      }

      if (registration.invocation.resultJson) {
        return registration.invocation
          .resultJson as unknown as FileToolResultEnvelope;
      }

      throw new AgentError(
        AGENT_ERROR_CODES.toolAlreadyExecuted,
        "重复的 Tool Call 尚未产生可复用结果。",
        409,
        { toolCallId: input.toolCallId },
      );
    }

    await this.store.markToolInvocationRunning({
      runId: input.run.id,
      toolCallId: input.toolCallId,
    });

    try {
      if (
        !input.run.repositoryCapability.canExecuteServerTools ||
        !input.run.repositoryCapability.canRead
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolInvalidArguments,
          "当前 Run 的 Repository capability 不允许服务端文件工具。",
          409,
        );
      }

      const parsedArguments = parseToolArguments(toolName, input.argumentsJson);
      await this.assertRunCanContinue(input.run);
      const result = await this.executeParsed({
        run: input.run,
        toolName,
        argumentsJson: parsedArguments,
      });

      await this.store.completeToolInvocation({
        runId: input.run.id,
        toolCallId: input.toolCallId,
        status: "succeeded",
        resultJson: result,
        revisionAfter: result.revision,
      });

      return result;
    } catch (error) {
      const envelope = toFailureEnvelope(toolName, error);
      await this.store.completeToolInvocation({
        runId: input.run.id,
        toolCallId: input.toolCallId,
        status:
          envelope.error.code === AGENT_ERROR_CODES.cancelled
            ? "cancelled"
            : "failed",
        resultJson: envelope,
        errorCode: envelope.error.code,
      });

      return envelope;
    }
  }

  private async executeParsed(input: {
    run: AgentRunRecord;
    toolName: FileToolName;
    argumentsJson: Record<string, unknown>;
  }): Promise<FileToolSuccessEnvelope> {
    const common = {
      ownerId: input.run.ownerId,
      projectId: input.run.projectId,
    };

    switch (input.toolName) {
      case FILE_TOOL_NAMES.listFiles: {
        const files = await this.repository.listFiles(common);
        return success(input.toolName, input.run.currentRevision, {
          files: files.map(({ path, byteLength, hash, updatedAt }) => ({
            path,
            byteLength,
            hash,
            updatedAt,
          })),
        });
      }
      case FILE_TOOL_NAMES.searchText: {
        const args = FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.searchText].parse(
          input.argumentsJson,
        );
        const matches = await this.repository.searchText({
          ...common,
          query: args.query,
          options: { maxResults: args.maxResults },
        });
        return success(input.toolName, input.run.currentRevision, { matches });
      }
      case FILE_TOOL_NAMES.readFile: {
        const args = FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.readFile].parse(
          input.argumentsJson,
        );
        const file = await this.repository.readFile({
          ...common,
          path: args.path,
        });
        return success(input.toolName, input.run.currentRevision, { file });
      }
      case FILE_TOOL_NAMES.writeFile: {
        const args = FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.writeFile].parse(
          input.argumentsJson,
        );
        await this.assertExpectedRevision(input.run, args.expectedRevision);
        const existing = await this.findFile(common, args.path);

        if (existing) {
          await this.assertReadBeforeMutation(
            input.run,
            args.path,
            args.expectedRevision,
          );
        }

        await this.assertRunCanContinue(input.run);
        const mutation = await this.repository.writeFile({
          ...common,
          ...args,
        });
        return success(input.toolName, mutation.revision, {
          changedPaths: mutation.changedPaths,
          operation: existing ? "update" : "create",
        });
      }
      case FILE_TOOL_NAMES.deleteFile: {
        const args = FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.deleteFile].parse(
          input.argumentsJson,
        );
        await this.assertExpectedRevision(input.run, args.expectedRevision);
        await this.assertReadBeforeMutation(
          input.run,
          args.path,
          args.expectedRevision,
        );
        await this.assertRunCanContinue(input.run);
        const mutation = await this.repository.deleteFile({
          ...common,
          ...args,
        });
        return success(input.toolName, mutation.revision, {
          changedPaths: mutation.changedPaths,
          operation: "delete",
        });
      }
      case FILE_TOOL_NAMES.renameFile: {
        const args = FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.renameFile].parse(
          input.argumentsJson,
        );
        await this.assertExpectedRevision(input.run, args.expectedRevision);
        await this.assertReadBeforeMutation(
          input.run,
          args.fromPath,
          args.expectedRevision,
        );
        await this.assertRunCanContinue(input.run);
        const mutation = await this.repository.renameFile({
          ...common,
          ...args,
        });
        return success(input.toolName, mutation.revision, {
          changedPaths: mutation.changedPaths,
          operation: "rename",
        });
      }
    }
  }

  private async assertExpectedRevision(
    run: AgentRunRecord,
    expectedRevision: number,
  ): Promise<void> {
    if (expectedRevision !== run.currentRevision) {
      throw new AgentError(
        AGENT_ERROR_CODES.revisionConflict,
        "Tool Call 使用了过期的项目 revision。",
        409,
        { expectedRevision, currentRevision: run.currentRevision },
      );
    }
  }

  private async assertReadBeforeMutation(
    run: AgentRunRecord,
    path: string,
    revision: number,
  ): Promise<void> {
    const hasRead = await this.store.findSuccessfulRead({
      runId: run.id,
      path,
      revision,
    });

    if (!hasRead) {
      throw new AgentError(
        AGENT_ERROR_CODES.toolReadRequired,
        "修改已有文件前必须在同一 Run 和 revision 下调用 read_file。",
        409,
        { path, revision },
      );
    }
  }

  private async assertRunCanContinue(run: AgentRunRecord): Promise<void> {
    const latest = await this.store.getRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    if (latest.cancellationRequestedAt || latest.status === "cancelled") {
      throw new AgentError(
        AGENT_ERROR_CODES.cancelled,
        "Agent Run 已请求取消，工具不会继续执行。",
        409,
      );
    }
  }

  private async findFile(
    common: { ownerId: string; projectId: string },
    path: string,
  ) {
    try {
      return await this.repository.readFile({ ...common, path });
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
}

function parseToolArguments(
  toolName: FileToolName,
  argumentsJson: unknown,
): Record<string, unknown> {
  const parsed = FILE_TOOL_SCHEMAS[toolName].safeParse(argumentsJson);

  if (!parsed.success) {
    throw new AgentError(
      AGENT_ERROR_CODES.toolInvalidArguments,
      `工具 ${toolName} 的参数不合法。`,
      400,
      { issues: parsed.error.issues },
    );
  }

  return parsed.data;
}

function assertFileToolName(value: string): FileToolName {
  if (Object.values(FILE_TOOL_NAMES).includes(value as FileToolName)) {
    return value as FileToolName;
  }

  throw new AgentError(
    AGENT_ERROR_CODES.toolInvalidArguments,
    `未知文件工具：${value}。`,
    400,
  );
}

function toLedgerArguments(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { invalidArguments: value };
}

function success(
  toolName: FileToolName,
  revision: number,
  data: Record<string, unknown>,
): FileToolSuccessEnvelope {
  return { ok: true, toolName, revision, data };
}

function toFailureEnvelope(
  toolName: FileToolName,
  error: unknown,
): FileToolFailureEnvelope {
  if (error instanceof AgentError) {
    return {
      ok: false,
      toolName,
      conflict: error.code === AGENT_ERROR_CODES.revisionConflict,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  if (isProjectError(error)) {
    const revisionConflict =
      error.code === PROJECT_ERROR_CODES.revisionConflict;
    return {
      ok: false,
      toolName,
      conflict: revisionConflict,
      error: {
        code: revisionConflict
          ? AGENT_ERROR_CODES.revisionConflict
          : error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  if (error instanceof z.ZodError) {
    return {
      ok: false,
      toolName,
      conflict: false,
      error: {
        code: AGENT_ERROR_CODES.toolInvalidArguments,
        message: `工具 ${toolName} 的参数不合法。`,
        details: { issues: error.issues },
      },
    };
  }

  return {
    ok: false,
    toolName,
    conflict: false,
    error: {
      code: "AGENT_TOOL_EXECUTION_FAILED",
      message: "文件工具执行失败。",
    },
  };
}
