import { isDeepStrictEqual } from "node:util";

import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import type { AgentStore } from "@/domains/agent/store";
import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { AgentRunRecord } from "@/domains/agent/types";
import { INSPECT_ATTACHMENT_TOOL_NAME } from "@/domains/image/vision-tool";
import { getOwnedAttachmentImage } from "@/domains/image/service";
import {
  inspectAttachmentArgumentsSchema,
  type VisionProvider,
} from "@/domains/image/vision";
import { ImageError } from "@/domains/image/errors";

export type VisionToolResultEnvelope = {
  ok: boolean;
  toolName: typeof INSPECT_ATTACHMENT_TOOL_NAME;
  revision: number;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

type AgentStoreLike = Pick<
  AgentStore<PgQueryResultHKT>,
  | "registerToolInvocation"
  | "markToolInvocationRunning"
  | "completeToolInvocation"
  | "getRun"
>;

/**
 * Vision 是服务端只读工具，但仍必须经过 Tool Ledger。
 *
 * 这样重复的模型 Tool Call 可以复用已完成摘要，超时或 Provider 错误也会
 * 留下失败记录，后续恢复不会再次无审计地读取私有图片。
 */
export class VisionToolExecutor {
  constructor(
    private readonly store: AgentStoreLike,
    private readonly provider: VisionProvider,
    private readonly options: {
      model: string;
      profile: string;
      profileVersion: string;
    },
  ) {}

  async execute(input: {
    run: AgentRunRecord;
    toolCallId: string;
    argumentsJson: unknown;
  }): Promise<VisionToolResultEnvelope> {
    const parsed = inspectAttachmentArgumentsSchema.safeParse(
      input.argumentsJson,
    );
    const ledgerArguments =
      input.argumentsJson !== null &&
      typeof input.argumentsJson === "object" &&
      !Array.isArray(input.argumentsJson)
        ? (input.argumentsJson as Record<string, unknown>)
        : { invalidArguments: input.argumentsJson };

    const registration = await this.store.registerToolInvocation({
      runId: input.run.id,
      toolCallId: input.toolCallId,
      toolName: INSPECT_ATTACHMENT_TOOL_NAME,
      executionDomain: "server",
      argumentsJson: ledgerArguments,
      idempotencyKey: `${input.run.id}:${input.toolCallId}`,
      revisionBefore: input.run.currentRevision,
    });

    if (!registration.created) {
      if (
        registration.invocation.toolName !== INSPECT_ATTACHMENT_TOOL_NAME ||
        !isDeepStrictEqual(
          registration.invocation.argumentsJson,
          ledgerArguments,
        )
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolAlreadyExecuted,
          "重复的 Vision Tool Call 携带了不同的参数。",
          409,
          { toolCallId: input.toolCallId },
        );
      }
      if (registration.invocation.resultJson) {
        return registration.invocation
          .resultJson as unknown as VisionToolResultEnvelope;
      }
      throw new AgentError(
        AGENT_ERROR_CODES.toolAlreadyExecuted,
        "重复的 Vision Tool Call 尚未产生可复用结果。",
        409,
      );
    }

    await this.store.markToolInvocationRunning({
      runId: input.run.id,
      toolCallId: input.toolCallId,
    });

    try {
      if (!parsed.success) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolInvalidArguments,
          "inspect_attachment 工具参数不合法。",
          400,
          { issues: parsed.error.issues },
        );
      }

      const latestRun = await this.store.getRun({
        ownerId: input.run.ownerId,
        runId: input.run.id,
      });
      if (
        latestRun.cancellationRequestedAt ||
        latestRun.status === "cancelled"
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.cancelled,
          "Agent Run 已请求取消，Vision 工具不会继续执行。",
          409,
        );
      }

      const images = await Promise.all(
        parsed.data.attachmentIds.map((attachmentId) =>
          getOwnedAttachmentImage({
            ownerId: input.run.ownerId,
            projectId: input.run.projectId,
            conversationId: input.run.conversationId,
            attachmentId,
          }),
        ),
      );
      const summary = await this.provider.inspect({
        images,
        prompt: parsed.data.prompt,
        model: this.options.model,
      });
      const result: VisionToolResultEnvelope = {
        ok: true,
        toolName: INSPECT_ATTACHMENT_TOOL_NAME,
        revision: input.run.currentRevision,
        data: {
          profile: this.options.profile,
          profileVersion: this.options.profileVersion,
          attachments: images.map((image) => ({
            attachmentId: image.attachmentId,
            filename: image.filename,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
          })),
          summary,
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

function toFailureResult(
  revision: number,
  error: unknown,
): VisionToolResultEnvelope {
  if (error instanceof AgentError || error instanceof ImageError) {
    return {
      ok: false,
      toolName: INSPECT_ATTACHMENT_TOOL_NAME,
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
    toolName: INSPECT_ATTACHMENT_TOOL_NAME,
    revision,
    error: {
      code: "IMAGE_VISION_INTERNAL_ERROR",
      message: "Vision 工具执行失败。",
    },
  };
}
