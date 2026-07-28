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
});
