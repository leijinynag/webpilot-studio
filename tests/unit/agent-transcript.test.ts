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

  it("丢弃供应商缺失 Tool Call 时产生的临时前言", () => {
    const events: AgentRunEvent[] = [
      {
        id: "event-1",
        runId: "run-1",
        sequence: 1,
        type: "assistant.delta",
        payload: { text: "我先检查项目结构。" },
        createdAt: new Date(),
      },
      {
        id: "event-2",
        runId: "run-1",
        sequence: 2,
        type: "model.turn_retried",
        payload: {
          reason: "empty_tool_calls",
          discardedCharacterCount: 9,
          consumedModelTurns: 1,
        },
        createdAt: new Date(),
      },
      {
        id: "event-3",
        runId: "run-1",
        sequence: 3,
        type: "assistant.delta",
        payload: { text: "正在读取文件..." },
        createdAt: new Date(),
      },
    ];

    expect(projectPendingAssistantText(events, "run-1")).toBe(
      "正在读取文件...",
    );
  });

  it("继续新 Run 时丢弃历史末尾未配对的 Tool Call", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        role: "user",
        kind: "user_message",
        content: "第一次修改",
      },
      {
        conversationId: "conversation",
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-orphan",
        toolName: "write_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation",
        role: "user",
        kind: "user_message",
        content: "继续完成剩余工作",
      },
      {
        conversationId: "conversation",
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-complete",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation",
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-complete",
        toolName: "read_file",
        resultJson: { ok: true },
      },
    ];

    expect(assembleProviderMessages(transcript)).toEqual([
      { role: "user", content: "第一次修改" },
      { role: "user", content: "继续完成剩余工作" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-complete",
            name: "read_file",
            argumentsJson: '{"path":"src/App.tsx"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-complete",
        content: '{"ok":true}',
      },
    ]);
  });

  it("长会话只保留最近的完整上下文单元", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        role: "user",
        kind: "user_message",
        content: "旧请求".repeat(100),
      },
      {
        conversationId: "conversation",
        role: "assistant",
        kind: "assistant_message",
        content: "旧回复".repeat(100),
      },
      {
        conversationId: "conversation",
        role: "user",
        kind: "user_message",
        content: "继续完成剩余工作",
      },
    ];

    expect(
      assembleProviderMessages(transcript, { maxContextCharacters: 120 }),
    ).toEqual([{ role: "user", content: "继续完成剩余工作" }]);
  });
});
