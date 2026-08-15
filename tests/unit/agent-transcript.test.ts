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

  it("小上下文预算不会拆散同一轮交叉排列的多个 Tool Call", () => {
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
        kind: "tool_call",
        toolCallId: "call-1",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation",
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-2",
        toolName: "read_file",
        argumentsJson: { path: "src/main.tsx" },
      },
      {
        conversationId: "conversation",
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-1",
        toolName: "read_file",
        resultJson: { ok: true, content: "App" },
      },
      {
        conversationId: "conversation",
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-2",
        toolName: "read_file",
        resultJson: { ok: true, content: "main" },
      },
    ];

    const messages = assembleProviderMessages(transcript, {
      maxContextCharacters: 100,
    });

    expect(
      messages.flatMap((message) =>
        message.role === "assistant"
          ? (message.toolCalls ?? []).map((toolCall) => toolCall.id)
          : [],
      ),
    ).toEqual(["call-1", "call-2"]);
    expect(
      messages.flatMap((message) =>
        message.role === "tool" && message.toolCallId
          ? [message.toolCallId]
          : [],
      ),
    ).toEqual(["call-1", "call-2"]);
    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "tool",
      "tool",
    ]);
  });

  it("空 Checkpoint 不过滤运行态或历史 Transcript", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        seq: 1,
        role: "user",
        kind: "user_message",
        content: "已经持久化的消息",
      },
      {
        conversationId: "conversation",
        role: "assistant",
        kind: "assistant_message",
        content: "尚未分配 seq 的运行态消息",
      },
    ];

    expect(
      assembleProviderMessages(transcript, {
        contextCheckpoint: {
          summary: null,
          transcriptSeq: 99,
          version: 3,
          updatedAt: new Date(),
        },
      }),
    ).toEqual([
      { role: "user", content: "已经持久化的消息" },
      { role: "assistant", content: "尚未分配 seq 的运行态消息" },
    ]);
  });

  it("并发 Checkpoint 已越过当前 Run 时仍保留当前 Run 的完整原文", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        runId: "run-old",
        seq: 1,
        role: "user",
        kind: "user_message",
        content: "已经进入摘要的旧 Run 消息",
      },
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 2,
        role: "user",
        kind: "user_message",
        content: "当前 Run 的早期指令",
      },
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 3,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-current",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 4,
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-current",
        toolName: "read_file",
        resultJson: { ok: true },
      },
      {
        conversationId: "conversation",
        runId: "run-other",
        seq: 6,
        role: "assistant",
        kind: "assistant_message",
        content: "Checkpoint 之后的其他 Run 消息",
      },
    ];

    expect(
      assembleProviderMessages(transcript, {
        contextCheckpoint: {
          summary: "旧历史摘要",
          transcriptSeq: 5,
          version: 2,
          updatedAt: new Date(),
        },
        protectedRunId: "run-current",
      }),
    ).toEqual([
      {
        role: "system",
        content:
          "以下是较早对话的 ContextCheckpoint 摘要。它只用于恢复上下文，若与后续完整消息冲突，以后续消息为准：\n\n旧历史摘要",
      },
      { role: "user", content: "当前 Run 的早期指令" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-current",
            name: "read_file",
            argumentsJson: '{"path":"src/App.tsx"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-current",
        content: '{"ok":true}',
      },
      { role: "assistant", content: "Checkpoint 之后的其他 Run 消息" },
    ]);
  });

  it("极小预算仍保留当前 Run 的全部消息", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 1,
        role: "user",
        kind: "user_message",
        content: "当前 Run 的第一条指令",
      },
      {
        conversationId: "conversation",
        runId: "run-other",
        seq: 2,
        role: "assistant",
        kind: "assistant_message",
        content: "其他 Run 的大段输出".repeat(100),
      },
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 3,
        role: "assistant",
        kind: "assistant_message",
        content: "当前 Run 的阶段结论",
      },
    ];

    expect(
      assembleProviderMessages(transcript, {
        protectedRunId: "run-current",
        maxContextCharacters: 1,
      }),
    ).toEqual([
      { role: "user", content: "当前 Run 的第一条指令" },
      { role: "assistant", content: "当前 Run 的阶段结论" },
    ]);
  });

  it("当前 Run 命中工具单元时完整保留 call/result 配对", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 1,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-current",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      },
      {
        conversationId: "conversation",
        runId: "run-other",
        seq: 2,
        role: "tool",
        kind: "tool_result",
        toolCallId: "call-current",
        toolName: "read_file",
        resultJson: { ok: true, content: "export default App" },
      },
    ];

    expect(
      assembleProviderMessages(transcript, {
        protectedRunId: "run-current",
        maxContextCharacters: 1,
      }),
    ).toEqual([
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call-current",
            name: "read_file",
            argumentsJson: '{"path":"src/App.tsx"}',
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-current",
        content: '{"ok":true,"content":"export default App"}',
      },
    ]);
  });

  it("非连续受保护消息不会被中间的超预算普通单元挡住", () => {
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 1,
        role: "user",
        kind: "user_message",
        content: "必须保留的早期指令",
      },
      {
        conversationId: "conversation",
        runId: "run-other",
        seq: 2,
        role: "assistant",
        kind: "assistant_message",
        content: "中间的大段普通历史".repeat(100),
      },
      {
        conversationId: "conversation",
        runId: "run-current",
        seq: 3,
        role: "assistant",
        kind: "assistant_message",
        content: "必须保留的最新进度",
      },
      {
        conversationId: "conversation",
        runId: "run-other",
        seq: 4,
        role: "user",
        kind: "user_message",
        content: "预算允许时保留的最近普通消息",
      },
    ];

    expect(
      assembleProviderMessages(transcript, {
        protectedRunId: "run-current",
        maxContextCharacters: 180,
      }),
    ).toEqual([
      { role: "user", content: "必须保留的早期指令" },
      { role: "assistant", content: "必须保留的最新进度" },
      { role: "user", content: "预算允许时保留的最近普通消息" },
    ]);
  });
});
