import { describe, expect, it } from "vitest";

import { assembleProviderMessages } from "@/domains/agent/transcript";
import type { TranscriptMessage } from "@/domains/agent/types";

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
});
