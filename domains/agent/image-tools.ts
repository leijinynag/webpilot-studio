import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import type { AgentRunRecord } from "@/domains/agent/types";
import type {
  GenerateImageArguments,
} from "@/domains/image/generation";
import {
  generateImageArgumentsSchema,
} from "@/domains/image/generation";
import {
  IMAGE_ERROR_CODES,
  ImageError,
} from "@/domains/image/errors";
import {
  GENERATE_IMAGE_TOOL_NAME,
} from "@/domains/image/generation-tool";
import type { AgentStore } from "@/domains/agent/store";
import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { JobQueue } from "@/infrastructure/queue/job-queue";

export type ImageToolResultEnvelope = {
  ok: boolean;
  toolName: typeof GENERATE_IMAGE_TOOL_NAME;
  revision: number;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

type ImageToolStore = Pick<
  AgentStore<PgQueryResultHKT>,
  "suspendForImageGeneration"
>;

/**
 * 只负责把模型 Tool Call 转成异步任务事实，不在请求线程执行图像模型。
 *
 * 返回 null 表示父 Agent 已切到 awaiting_async_job，Orchestrator 应立即结束
 * 当前执行片段；实际 tool_result 由 Worker 在资产落库后补写。
 */
export class ImageToolExecutor {
  constructor(
    private readonly store: ImageToolStore,
    private readonly queue: JobQueue,
    private readonly options: {
      provider: string;
      model: string;
      profile: string;
      profileVersion: string;
    } | null,
  ) {}

  async suspend(input: {
    run: AgentRunRecord;
    toolCallId: string;
    argumentsJson: unknown;
    leaseId: string;
  }): Promise<{ imageRunId: string; imageJobId: string }> {
    if (!this.options) {
      throw new ImageError(
        IMAGE_ERROR_CODES.generationNotConfigured,
        "图片生成尚未配置 IMAGE_API_KEY 或未启用。",
        503,
      );
    }

    const parsed = generateImageArgumentsSchema.safeParse(input.argumentsJson);
    if (!parsed.success) {
      throw new AgentError(
        AGENT_ERROR_CODES.toolInvalidArguments,
        "工具 generate_image 的参数不合法。",
        400,
        { issues: parsed.error.issues },
      );
    }

    if (input.run.usage.clientResumes >= input.run.budget.maxClientResumes) {
      throw new AgentError(
        AGENT_ERROR_CODES.budgetExhausted,
        "Agent 已达到异步任务恢复次数上限。",
        409,
      );
    }

    const job = await this.store.suspendForImageGeneration({
      ownerId: input.run.ownerId,
      runId: input.run.id,
      projectId: input.run.projectId,
      conversationId: input.run.conversationId,
      toolCallId: input.toolCallId,
      argumentsJson: parsed.data as GenerateImageArguments,
      idempotencyKey: `${input.run.id}:${input.toolCallId}`,
      revision: input.run.currentRevision,
      leaseId: input.leaseId,
      provider: this.options.provider,
      model: this.options.model,
      profile: this.options.profile,
      profileVersion: this.options.profileVersion,
    });

    // 任务记录已经在数据库事务中提交，队列发送失败时仍可由恢复入口重新
    // 投递；不能把真实生图请求放在当前模型请求线程内同步执行。
    await this.queue.enqueue({
      imageJobId: job.imageJobId,
      imageRunId: job.imageRunId,
    });

    return job;
  }
}
