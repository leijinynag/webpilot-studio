import { describe, expect, it } from "vitest";

import {
  applyStreamingFileEvents,
  createStreamingFileProjectionState,
  dismissStreamingFileProjection,
  getStreamingFileProjectionId,
  handoffStreamingFileProjection,
} from "@/domains/agent/streaming-file-projection";
import type { AgentRunEvent } from "@/domains/agent/types";

const conversationId = "conversation-1";
const runId = "run-1";

function createEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown>,
  eventRunId = runId,
): AgentRunEvent {
  return {
    id: `event-${eventRunId}-${sequence}`,
    runId: eventRunId,
    sequence,
    type,
    payload,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
  };
}

describe("streaming file projection", () => {
  it("按持久化事件增量创建、追加并完成临时文件", () => {
    const state = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(3, "file.stream_completed", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
          characterCount: 12,
        }),
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
        createEvent(2, "file.stream_delta", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
          text: "export default",
        }),
      ],
    });

    expect(state.projections[`${runId}:tool-1`]).toMatchObject({
      content: "export default",
      path: "src/app.tsx",
      status: "completed",
      lastSequence: 3,
    });
    expect(state.sequenceByRun[runId]).toBe(3);
  });

  it("拒绝 SSE 与快照中的重复或过期序号", () => {
    const initial = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
        createEvent(2, "file.stream_delta", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
          text: "A",
        }),
      ],
    });

    const replayed = applyStreamingFileEvents({
      state: initial,
      conversationId,
      events: [
        createEvent(2, "file.stream_delta", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
          text: "A",
        }),
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
      ],
    });

    expect(replayed.projections[`${runId}:tool-1`]?.content).toBe("A");
    expect(replayed.sequenceByRun[runId]).toBe(2);
  });

  it("并行维护同一 Run 中的多个 write_file Tool Call", () => {
    const state = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/a.ts",
        }),
        createEvent(2, "file.stream_started", {
          toolCallId: "tool-2",
          path: "src/b.ts",
        }),
        createEvent(3, "file.stream_delta", {
          toolCallId: "tool-2",
          path: "src/b.ts",
          text: "B",
        }),
        createEvent(4, "file.stream_delta", {
          toolCallId: "tool-1",
          path: "src/a.ts",
          text: "A",
        }),
      ],
    });

    expect(state.order).toEqual([`${runId}:tool-1`, `${runId}:tool-2`]);
    expect(state.projections[`${runId}:tool-1`]?.content).toBe("A");
    expect(state.projections[`${runId}:tool-2`]?.content).toBe("B");
  });

  it("丢弃事件与失败的正式工具结果都会回收临时投影", () => {
    const started = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/a.ts",
        }),
        createEvent(2, "file.stream_started", {
          toolCallId: "tool-2",
          path: "src/b.ts",
        }),
      ],
    });
    const state = applyStreamingFileEvents({
      state: started,
      conversationId,
      events: [
        createEvent(3, "file.stream_discarded", {
          toolCallId: "tool-1",
          reason: "cancelled",
        }),
        createEvent(4, "tool.completed", {
          toolCallId: "tool-2",
          toolName: "write_file",
          ok: false,
          revision: 7,
        }),
      ],
    });

    expect(state.projections).toEqual({});
    expect(state.order).toEqual([]);
    expect(state.sequenceByRun[runId]).toBe(4);
  });

  it("成功工具结果等待 Repository revision 与真实路径同时就绪", () => {
    const projectionId = getStreamingFileProjectionId(runId, "tool-1");
    const state = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
        createEvent(2, "file.stream_delta", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
          text: "export default function App() {}",
        }),
        createEvent(3, "tool.completed", {
          toolCallId: "tool-1",
          toolName: "write_file",
          ok: true,
          revision: 8,
        }),
      ],
    });

    expect(state.projections[projectionId]).toMatchObject({
      status: "awaiting_repository",
      repositoryRevision: 8,
    });
    expect(
      handoffStreamingFileProjection({
        state,
        projectionId,
        repositoryRevision: 7,
        repositoryPaths: new Set(["src/app.tsx"]),
      }),
    ).toBeNull();
    expect(
      handoffStreamingFileProjection({
        state,
        projectionId,
        repositoryRevision: 8,
        repositoryPaths: new Set(),
      }),
    ).toBeNull();

    const handoff = handoffStreamingFileProjection({
      state,
      projectionId,
      repositoryRevision: 8,
      repositoryPaths: new Set(["src/app.tsx"]),
    });
    expect(handoff?.projection.path).toBe("src/app.tsx");
    expect(handoff?.state.projections).toEqual({});
    expect(handoff?.state.sequenceByRun[runId]).toBe(3);
  });

  it("用户关闭临时标签后保留游标，快照重放不会重新打开", () => {
    const projectionId = getStreamingFileProjectionId(runId, "tool-1");
    const started = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
      ],
    });
    const dismissed = dismissStreamingFileProjection(started, projectionId);
    const replayed = applyStreamingFileEvents({
      state: dismissed,
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
      ],
    });

    expect(replayed.projections).toEqual({});
    expect(replayed.sequenceByRun[runId]).toBe(1);
  });

  it("切换 Conversation 时清空投影与旧 Run 游标", () => {
    const previous = applyStreamingFileEvents({
      state: createStreamingFileProjectionState(),
      conversationId,
      events: [
        createEvent(1, "file.stream_started", {
          toolCallId: "tool-1",
          path: "src/app.tsx",
        }),
      ],
    });
    const next = applyStreamingFileEvents({
      state: previous,
      conversationId: "conversation-2",
      events: [],
    });

    expect(next).toEqual(createStreamingFileProjectionState("conversation-2"));
  });
});
