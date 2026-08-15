import type { AgentRunEvent } from "@/domains/agent/types";

export const STREAMING_FILE_EVENT_TYPES = [
  "file.stream_started",
  "file.stream_delta",
  "file.stream_completed",
  "file.stream_discarded",
] as const;

export type StreamingFileProjectionStatus =
  "streaming" | "completed" | "awaiting_repository";

export type StreamingFileProjection = {
  id: string;
  runId: string;
  toolCallId: string;
  path: string;
  content: string;
  status: StreamingFileProjectionStatus;
  lastSequence: number;
  repositoryRevision: number | null;
};

export type StreamingFileProjectionState = {
  conversationId: string | null;
  projections: Record<string, StreamingFileProjection>;
  order: string[];
  /**
   * 关闭临时标签时只删除 projection，不删除游标。
   *
   * Agent 快照会重放当前 Conversation 的全部历史事件；保留每个 Run 已处理到的
   * sequence，才能保证用户主动关闭、工具失败或服务端丢弃后，旧事件不会把临时
   * 文件再次创建出来。
   */
  sequenceByRun: Record<string, number>;
};

export type StreamingFileRepositoryHandoff = {
  projection: StreamingFileProjection;
  state: StreamingFileProjectionState;
};

export function createStreamingFileProjectionState(
  conversationId: string | null = null,
): StreamingFileProjectionState {
  return {
    conversationId,
    projections: {},
    order: [],
    sequenceByRun: {},
  };
}

export function getStreamingFileProjectionId(
  runId: string,
  toolCallId: string,
): string {
  return `${runId}:${toolCallId}`;
}

/**
 * SSE 与聚合快照会并发携带同一批持久化事件，因此投影必须只依赖数据库 sequence
 * 前进。快照中的事件先按 sequence 排序，避免网络层或测试夹具的数组顺序影响结果；
 * 不同 Run 使用各自游标，历史 Run 与当前 Run 互不阻塞。
 */
export function applyStreamingFileEvents(input: {
  state: StreamingFileProjectionState;
  conversationId: string;
  events: readonly AgentRunEvent[];
}): StreamingFileProjectionState {
  let state =
    input.state.conversationId === input.conversationId
      ? input.state
      : createStreamingFileProjectionState(input.conversationId);

  const events = [...input.events].sort(
    (left, right) => left.sequence - right.sequence,
  );

  for (const event of events) {
    const previousSequence = state.sequenceByRun[event.runId] ?? 0;
    if (
      !Number.isInteger(event.sequence) ||
      event.sequence <= previousSequence
    ) {
      continue;
    }

    // 即使 payload 损坏也消费该持久化序号，避免下一次快照持续重复解析同一坏事件。
    state = {
      ...state,
      sequenceByRun: {
        ...state.sequenceByRun,
        [event.runId]: event.sequence,
      },
    };

    state = applyStreamingFileEvent(state, event);
  }

  return state;
}

export function dismissStreamingFileProjection(
  state: StreamingFileProjectionState,
  projectionId: string,
): StreamingFileProjectionState {
  if (!state.projections[projectionId]) {
    return state;
  }

  return removeProjection(state, projectionId);
}

/**
 * tool.completed 成功只说明 Repository mutation 已完成，不代表工作台已经读到该
 * revision。只有 revision 达标且真实路径存在时才移除临时投影，并把待打开的正式
 * 文件交给组件；这避免网络较慢时编辑器先闪回空态或旧内容。
 */
export function handoffStreamingFileProjection(input: {
  state: StreamingFileProjectionState;
  repositoryRevision: number;
  repositoryPaths: ReadonlySet<string>;
  projectionId: string;
}): StreamingFileRepositoryHandoff | null {
  const projection = input.state.projections[input.projectionId];
  if (
    !projection ||
    projection.status !== "awaiting_repository" ||
    projection.repositoryRevision === null ||
    input.repositoryRevision < projection.repositoryRevision ||
    !input.repositoryPaths.has(projection.path)
  ) {
    return null;
  }

  return {
    projection,
    state: removeProjection(input.state, projection.id),
  };
}

function applyStreamingFileEvent(
  state: StreamingFileProjectionState,
  event: AgentRunEvent,
): StreamingFileProjectionState {
  const toolCallId = readNonemptyString(event.payload.toolCallId);
  if (!toolCallId) {
    return state;
  }

  const projectionId = getStreamingFileProjectionId(event.runId, toolCallId);
  const current = state.projections[projectionId];

  switch (event.type) {
    case "file.stream_started": {
      const path = readNonemptyString(event.payload.path);
      if (!path || current) {
        return state;
      }

      return {
        ...state,
        projections: {
          ...state.projections,
          [projectionId]: {
            id: projectionId,
            runId: event.runId,
            toolCallId,
            path,
            content: "",
            status: "streaming",
            lastSequence: event.sequence,
            repositoryRevision: null,
          },
        },
        order: [...state.order, projectionId],
      };
    }

    case "file.stream_delta": {
      const path = readNonemptyString(event.payload.path);
      const text =
        typeof event.payload.text === "string" ? event.payload.text : null;
      if (!current || !path || path !== current.path || text === null) {
        return state;
      }

      return updateProjection(state, {
        ...current,
        content: current.content + text,
        status:
          current.status === "awaiting_repository"
            ? current.status
            : "streaming",
        lastSequence: event.sequence,
      });
    }

    case "file.stream_completed": {
      const path = readNonemptyString(event.payload.path);
      if (!current || !path || path !== current.path) {
        return state;
      }

      return updateProjection(state, {
        ...current,
        status:
          current.status === "awaiting_repository"
            ? current.status
            : "completed",
        lastSequence: event.sequence,
      });
    }

    case "file.stream_discarded":
      return current ? removeProjection(state, projectionId) : state;

    case "tool.completed": {
      if (event.payload.toolName !== "write_file" || !current) {
        return state;
      }

      if (event.payload.ok !== true) {
        return removeProjection(state, projectionId);
      }

      const revision = readNonnegativeInteger(event.payload.revision);
      if (revision === null) {
        return state;
      }

      return updateProjection(state, {
        ...current,
        status: "awaiting_repository",
        lastSequence: event.sequence,
        repositoryRevision: revision,
      });
    }

    default:
      return state;
  }
}

function updateProjection(
  state: StreamingFileProjectionState,
  projection: StreamingFileProjection,
): StreamingFileProjectionState {
  return {
    ...state,
    projections: {
      ...state.projections,
      [projection.id]: projection,
    },
  };
}

function removeProjection(
  state: StreamingFileProjectionState,
  projectionId: string,
): StreamingFileProjectionState {
  const projections = { ...state.projections };
  delete projections[projectionId];

  return {
    ...state,
    projections,
    order: state.order.filter((id) => id !== projectionId),
  };
}

function readNonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}
