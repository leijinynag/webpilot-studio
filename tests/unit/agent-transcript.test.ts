import { describe, expect, it } from "vitest";

import {
  assembleProviderMessages,
  projectPendingAssistantText,
} from "@/domains/agent/transcript";
import type { AgentRunEvent, TranscriptMessage } from "@/domains/agent/types";

describe("Agent transcript assembler", () => {
  it("projects domain messages without leaking system events", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        role: "user",
        kind: "user_message",
        content: "修改标题",
      },
      {
        conversationId: "conversation",
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-1",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation",
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-1",
        toolName: "read_file",
        resultJson: { ok: true, content: "export default App" },
      },
      {
        conversationId: "conversation",
        role: "system",
        kind: "system_event",
        eventType: "run.progress",
        data: { phase: "reading" },
      },
    ];

    expect(
      assembleProviderMessages(transcript, { systemPrompt: "system" }),
    ).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "修改标题" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            argumentsJson: '{"path":"src/App.tsx"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: '{"ok":true,"content":"export default App"}',
      },
    ]);
  });

  it("rebuilds the unfinished assistant message from persisted deltas", () => {
    const events: AgentRunEvent[] = [
      {
        id: "event-1",
        runId: "run-1",
        sequence: 1,
        type: "assistant.delta",
        payload: { text: "正在" },
        createdAt: new Date(),
      },
      {
        id: "event-2",
        runId: "run-1",
        sequence: 2,
        type: "assistant.delta",
        payload: { text: "生成..." },
        createdAt: new Date(),
      },
      {
        id: "event-3",
        runId: "run-1",
        sequence: 3,
        type: "run.progress",
        payload: { phase: "model" },
        createdAt: new Date(),
      },
    ];

    expect(projectPendingAssistantText(events, "run-1")).toBe("正在生成...");
    expect(projectPendingAssistantText(events, "run-other")).toBe("");
  });

  it("resets the projection after the completed assistant event", () => {
    const events: AgentRunEvent[] = [
      {
        id: "event-1",
        runId: "run-1",
        sequence: 1,
        type: "assistant.delta",
        payload: { text: "第一轮" },
        createdAt: new Date(),
      },
      {
        id: "event-2",
        runId: "run-1",
        sequence: 2,
        type: "assistant.completed",
        payload: { characterCount: 3 },
        createdAt: new Date(),
      },
      {
        id: "event-3",
        runId: "run-1",
        sequence: 3,
        type: "assistant.delta",
        payload: { text: "第二轮未完成" },
        createdAt: new Date(),
      },
    ];

    expect(projectPendingAssistantText(events, "run-1")).toBe("第二轮未完成");
  });
});
