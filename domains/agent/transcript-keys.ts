import type { TranscriptMessage } from "@/domains/agent/types";

/**
 * Transcript 消息在没有数据库 id 的单测/迁移投影中仍需要稳定键。
 * 这个纯领域函数不能依赖 server-only 的附件基础设施，避免客户端组件
 * 通过 Transcript 间接引入服务端模块。
 */
export function getTranscriptMessageKey(message: TranscriptMessage): string {
  return message.id ?? `${message.conversationId}:${message.seq ?? "unknown"}`;
}
