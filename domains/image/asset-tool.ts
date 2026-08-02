import { isDeepStrictEqual } from "node:util";

import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { AgentStore } from "@/domains/agent/store";
import type { AgentRunRecord } from "@/domains/agent/types";
import { createSignedAssetUrl } from "@/domains/image/asset-url";
import {
  listOwnedAssetRows,
  toAssetToolView,
} from "@/domains/image/service";
import { LIST_PROJECT_ASSETS_TOOL_NAME } from "@/domains/image/asset-tool-definition";

export type AssetToolResultEnvelope = {
  ok: boolean;
  toolName: typeof LIST_PROJECT_ASSETS_TOOL_NAME;
  revision: number;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

type AssetToolStore = Pick<
  AgentStore<PgQueryResultHKT>,
  | "registerToolInvocation"
  | "markToolInvocationRunning"
  | "completeToolInvocation"
  | "getRun"
>;

/**
 * 项目资产是服务端只读工具，但仍然需要进入 Tool Ledger。
 *
 * 资产列表可能因刷新或 Provider 重试被重复请求。相同 toolCallId 直接复用
 * 已完成结果，参数变化则拒绝，避免一次模型调用被悄悄重放成另一种语义。
 */
export class AssetToolExecutor {
  constructor(private readonly store: AssetToolStore) {}

  async execute(input: {
    run: AgentRunRecord;
    toolCallId: string;
    argumentsJson: unknown;
  }): Promise<AssetToolResultEnvelope> {
    const ledgerArguments = toLedgerArguments(input.argumentsJson);
    const registration = await this.store.registerToolInvocation({
      runId: input.run.id,
      toolCallId: input.toolCallId,
      toolName: LIST_PROJECT_ASSETS_TOOL_NAME,
      executionDomain: "server",
      argumentsJson: ledgerArguments,
      idempotencyKey: `${input.run.id}:${input.toolCallId}`,
      revisionBefore: input.run.currentRevision,
    });

    if (!registration.created) {
      if (
        registration.invocation.toolName !== LIST_PROJECT_ASSETS_TOOL_NAME ||
        !isDeepStrictEqual(
          registration.invocation.argumentsJson,
          ledgerArguments,
        )
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          "重复的资产工具调用携带了不同的参数。",
          409,
          { toolCallId: input.toolCallId },
        );
      }

      if (registration.invocation.resultJson) {
        return registration.invocation
          .resultJson as unknown as AssetToolResultEnvelope;
      }

      throw new AgentError(
        AGENT_ERROR_CODES.toolAlreadyExecuted,
        "重复的资产工具调用尚未产生可复用结果。",
        409,
      );
    }

    await this.store.markToolInvocationRunning({
      runId: input.run.id,
      toolCallId: input.toolCallId,
    });

    try {
      if (!isEmptyArguments(input.argumentsJson)) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolInvalidArguments,
          "工具 list_project_assets 不接受参数。",
          400,
        );
      }

      const latestRun = await this.store.getRun({
        ownerId: input.run.ownerId,
        runId: input.run.id,
      });
      if (latestRun.cancellationRequestedAt || latestRun.status === "cancelled") {
        throw new AgentError(
          AGENT_ERROR_CODES.cancelled,
          "Agent Run 已请求取消，资产工具不会继续执行。",
          409,
        );
      }

      const assets = await listOwnedAssetRows({
        ownerId: input.run.ownerId,
        projectId: input.run.projectId,
      });
      const result: AssetToolResultEnvelope = {
        ok: true,
        toolName: LIST_PROJECT_ASSETS_TOOL_NAME,
        revision: input.run.currentRevision,
        data: {
          assets: assets.map((asset) => ({
            ...toAssetToolView(asset),
            assetPath: `/__webpilot/assets/${asset.id}`,
            previewUrl: createSignedAssetUrl({
              asset,
            }),
          })),
        },
      };

      await this.store.completeToolInvocation({
        runId: input.run.id,
        toolCallId: input.toolCallId,
        status: "succeeded",
        resultJson: result,
        revisionAfter: input.run.currentRevision,
      });
      return result;
    } catch (error) {
      const result = toFailureResult(input.run.currentRevision, error);
      await this.store.completeToolInvocation({
        runId: input.run.id,
        toolCallId: input.toolCallId,
        status:
          result.error?.code === AGENT_ERROR_CODES.cancelled
            ? "cancelled"
            : "failed",
        resultJson: result,
        errorCode: result.error?.code,
      });
      return result;
    }
  }
}

function isEmptyArguments(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function toLedgerArguments(value: unknown): Record<string, unknown> {
  return isEmptyArguments(value) ? {} : { invalidArguments: value };
}

function toFailureResult(
  revision: number,
  error: unknown,
): AssetToolResultEnvelope {
  if (error instanceof AgentError) {
    return {
      ok: false,
      toolName: LIST_PROJECT_ASSETS_TOOL_NAME,
      revision,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  return {
    ok: false,
    toolName: LIST_PROJECT_ASSETS_TOOL_NAME,
    revision,
    error: {
      code: "IMAGE_ASSET_TOOL_INTERNAL_ERROR",
      message: "项目资产工具执行失败。",
    },
  };
}
