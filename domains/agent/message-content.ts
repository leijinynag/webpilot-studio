/**
 * 图片-only 消息仍然需要一个稳定的数据库正文，才能复用现有的
 * Transcript、会话标题和审计结构。这个占位符只存在于内部事实记录，
 * 客户端渲染时会隐藏，不会作为用户可见的聊天正文。
 */
export const IMAGE_ONLY_MESSAGE_CONTENT = "[Image attachment]";

export function isImageOnlyMessageContent(value: string): boolean {
  return value === IMAGE_ONLY_MESSAGE_CONTENT;
}
