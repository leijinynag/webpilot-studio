// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  formatAgentHeartbeatSse,
  formatAgentRunEventSse,
} from "@/infrastructure/http/agent-sse";

describe("Agent Run SSE", () => {
  it("uses the persisted event sequence as Last-Event-ID cursor", () => {
    const createdAt = new Date("2026-07-27T12:00:00.000Z");
    const payload = formatAgentRunEventSse({
      id: "event-1",
      runId: "run-1",
      sequence: 42,
      type: "assistant.delta",
      payload: { text: "完成" },
      createdAt,
    });

    expect(payload).toBe(
      `id: 42\nevent: assistant.delta\ndata: ${JSON.stringify({
        id: "event-1",
        runId: "run-1",
        sequence: 42,
        type: "assistant.delta",
        payload: { text: "完成" },
        createdAt,
      })}\n\n`,
    );
  });

  it("emits a comment heartbeat that does not advance the cursor", () => {
    expect(formatAgentHeartbeatSse()).toBe(": heartbeat\n\n");
  });

  it("keeps event type and sequence stable for cursor-based replay", () => {
    const first = formatAgentRunEventSse({
      id: "event-1",
      runId: "run-1",
      sequence: 10,
      type: "run.progress",
      payload: { phase: "model" },
      createdAt: new Date("2026-07-27T12:00:00.000Z"),
    });
    const replayedAfterCursor = formatAgentRunEventSse({
      id: "event-2",
      runId: "run-1",
      sequence: 11,
      type: "tool.started",
      payload: { toolName: "read_file" },
      createdAt: new Date("2026-07-27T12:00:01.000Z"),
    });

    expect(first).toContain("id: 10\n");
    expect(first).toContain("event: run.progress\n");
    expect(replayedAfterCursor).toContain("id: 11\n");
    expect(replayedAfterCursor).toContain("event: tool.started\n");
    expect(replayedAfterCursor).not.toContain("id: 10\n");
  });
});
