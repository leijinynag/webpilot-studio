import type { AgentRunEvent } from "@/domains/agent/types";

/**
 * SSE 的 id 使用数据库 identity sequence。浏览器重连时会把它放入
 * Last-Event-ID，服务端再按 sequence 查询，因此不会依赖内存游标。
 */
export function formatAgentRunEventSse(event: AgentRunEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

export function formatAgentHeartbeatSse(): string {
  return ": heartbeat\n\n";
}
