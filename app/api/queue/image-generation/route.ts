import { handleCallback } from "@vercel/queue";

import { imageJobMessageSchema } from "@/infrastructure/queue/job-queue";
import { processNextImageJob } from "@/domains/image/worker";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Vercel Queue 的图片生成消费者。
 *
 * Queue 自己负责消息的接收、续租和确认；这里保留 payload 校验，是为了
 * 防止错误 topic、旧版本消息或人工误投递把 Worker 指向错误的 image run。
 * 不合法消息会被确认并记录，合法消息则交给数据库 lease 保护的 Worker。
 */
export const POST = handleCallback(
  async (message, metadata) => {
    const parsed = imageJobMessageSchema.safeParse(message);
    if (!parsed.success) {
      console.error(
        "[image-generation-queue] invalid message",
        JSON.stringify({
          messageId: metadata.messageId,
          topicName: metadata.topicName,
          issues: parsed.error.issues,
        }),
      );
      return;
    }

    await processNextImageJob({
      expectedJobId: parsed.data.imageJobId,
      expectedImageRunId: parsed.data.imageRunId,
    });
  },
  {
    visibilityTimeoutSeconds: 180,
  },
);
