import "server-only";

import type { AgentRunRecord, TranscriptMessage } from "@/domains/agent/types";
import { getTranscriptMessageKey } from "@/domains/agent/transcript-keys";
import type { VisionProvider } from "@/domains/image/vision";
import { getOwnedAttachmentImage } from "@/domains/image/service";
import type { VisionSummary } from "@/domains/image/vision-summary";

export type AttachmentContextResolver = {
  resolve(input: {
    run: AgentRunRecord;
    transcript: readonly TranscriptMessage[];
    signal?: AbortSignal;
  }): Promise<Map<string, string>>;
};

/**
 * 自动视觉理解只处理本次 Run 新增的用户消息。
 *
 * 图片二进制通过项目、会话和 owner 约束读取，再交给独立 Vision Provider。
 * 返回的文本是 Provider 调用时的临时投影，不写入 Transcript，也不会进入
 * Tool Ledger，避免把一次首轮观察伪装成模型主动调用的工具事实。
 */
export function createAttachmentContextResolver(
  provider: VisionProvider,
  model: string,
): AttachmentContextResolver {
  return {
    async resolve({ run, transcript, signal }) {
      const contexts = new Map<string, string>();
      const messages = transcript.filter(
        (message): message is Extract<TranscriptMessage, { kind: "user_message" }> =>
          message.kind === "user_message" &&
          message.runId === run.id &&
          Boolean(message.attachmentIds?.length),
      );

      for (const message of messages) {
        const attachmentIds = message.attachmentIds ?? [];
        const images = await Promise.all(
          attachmentIds.map((attachmentId) =>
            getOwnedAttachmentImage({
              ownerId: run.ownerId,
              projectId: run.projectId,
              conversationId: run.conversationId,
              attachmentId,
            }),
          ),
        );
        const summary = await provider.inspect({
          images,
          model,
          signal,
          prompt:
            "请概括这条用户消息中的图片，重点说明界面结构、可见文字、主要对象和可能需要修改的视觉细节。",
        });

        contexts.set(getTranscriptMessageKey(message), formatVisionContext(summary));
      }

      return contexts;
    },
  };
}

function formatVisionContext(summary: VisionSummary): string {
  return [
    "[Image understanding]",
    `Description: ${summary.description}`,
    `Objects: ${summary.objects.join(", ") || "none"}`,
    `Text: ${summary.text.join(" | ") || "none"}`,
    `Colors: ${summary.colors.join(", ") || "none"}`,
    `Layout: ${summary.layout || "unknown"}`,
    `Confidence: ${summary.confidence.toFixed(2)}`,
  ].join("\n");
}
