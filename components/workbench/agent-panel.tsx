"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleStop,
  FileCode2,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Send,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  AgentConversationSnapshot,
  AgentRunRecord,
  ConversationRecord,
  ToolInvocationRecord,
  TranscriptMessage,
} from "@/domains/agent/types";
import { projectPendingAssistantText } from "@/domains/agent/transcript";
import { cn } from "@/lib/utils";

type AgentPanelProps = {
  projectId: string;
  revision: number;
  onRevisionChange?: (revision: number) => void;
};

type AgentResponse = {
  conversations: ConversationRecord[];
  snapshot: AgentConversationSnapshot | null;
};

type AgentErrorResponse = {
  error?: { message?: string };
};

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "conflicted",
]);

export function AgentPanel({
  projectId,
  revision,
  onRevisionChange,
}: AgentPanelProps) {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [snapshot, setSnapshot] = useState<AgentConversationSnapshot | null>(
    null,
  );
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const streamRef = useRef<EventSource | null>(null);
  const streamRunIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastEventIdRef = useRef(0);
  const selectedConversationRef = useRef<string | null>(null);
  const reconnectStreamRef = useRef<(() => void) | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const snapshotRequestRef = useRef(0);

  const activeRun = useMemo(
    () =>
      snapshot?.runs
        .slice()
        .reverse()
        .find((run) => !TERMINAL_STATUSES.has(run.status)) ?? null,
    [snapshot?.runs],
  );
  const latestRun = snapshot?.runs.at(-1) ?? null;
  const activeTool = useMemo(
    () =>
      activeRun
        ? (snapshot?.tools
            .slice()
            .reverse()
            .find(
              (tool) =>
                tool.runId === activeRun.id &&
                (tool.status === "running" || tool.status === "created"),
            ) ?? null)
        : null,
    [activeRun, snapshot?.tools],
  );

  const loadAgentSnapshot = useCallback(
    async (
      conversationId?: string | null,
      options: { showLoading?: boolean } = {},
    ) => {
      const requestId = snapshotRequestRef.current + 1;
      snapshotRequestRef.current = requestId;
      if (options.showLoading !== false) {
        setLoading(true);
      }

      try {
        const body = await fetchAgentSnapshot(projectId, conversationId);
        // SSE 事件可能同时触发多个快照请求，只接受最后一次请求的结果，
        // 避免较早的慢响应覆盖刚刚到达的最新 Transcript。
        if (requestId === snapshotRequestRef.current) {
          applySnapshot(body);
        }
      } catch (error) {
        if (requestId === snapshotRequestRef.current) {
          setErrorMessage(
            error instanceof Error ? error.message : "无法加载 Agent 会话。",
          );
        }
      } finally {
        if (requestId === snapshotRequestRef.current) {
          setLoading(false);
        }
      }
    },
    [projectId],
  );

  function applySnapshot(body: AgentResponse) {
    setConversations(body.conversations);
    setSnapshot(body.snapshot);
    setSelectedConversationId(body.snapshot?.conversation.id ?? null);
    const activeSnapshotRun = findActiveRun(body.snapshot?.runs ?? []);
    setStreamingAssistantText(
      projectPendingAssistantText(
        body.snapshot?.events ?? [],
        activeSnapshotRun?.id ?? null,
      ),
    );
    lastEventIdRef.current =
      body.snapshot?.events.reduce(
        (cursor, event) => Math.max(cursor, event.sequence),
        0,
      ) ?? 0;
    setErrorMessage(null);
  }

  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    let cancelled = false;

    void fetchAgentSnapshot(projectId)
      .then((body) => {
        if (!cancelled) {
          applySnapshot(body);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "无法加载 Agent 会话。",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const reconnectStream = useCallback(() => {
    const runId = activeRun?.id;

    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (!runId) {
      streamRef.current?.close();
      streamRef.current = null;
      streamRunIdRef.current = null;
      return;
    }

    // 游标保存在 ref 中，避免每条 SSE 事件都触发 EventSource 重建。
    // 连接生命周期只跟随当前 Run 变化，断线时仍从最新持久化游标恢复。
    streamRef.current?.close();
    streamRunIdRef.current = runId;
    const cursor =
      lastEventIdRef.current > 0 ? `?cursor=${lastEventIdRef.current}` : "";
    const stream = new EventSource(`/api/agent-runs/${runId}/events${cursor}`);
    streamRef.current = stream;

    const handleEvent = (event: Event) => {
      const sequence = Number((event as MessageEvent).lastEventId);
      if (Number.isFinite(sequence) && sequence > lastEventIdRef.current) {
        lastEventIdRef.current = sequence;
      }

      const messageEvent = event as MessageEvent<string>;
      const persistedEvent = parsePersistedEvent(messageEvent.data);

      if (
        persistedEvent?.runId === runId &&
        persistedEvent.type === "assistant.delta" &&
        typeof persistedEvent.payload.text === "string"
      ) {
        setStreamingAssistantText((current) => {
          return current + persistedEvent.payload.text;
        });
      } else if (
        persistedEvent?.runId === runId &&
        persistedEvent.type === "assistant.completed"
      ) {
        setStreamingAssistantText("");
      }

      // 增量文本先即时投影，快照随后负责收敛 Transcript、工具和 Run 状态。
      // 这样重连、刷新和事件乱序仍以数据库事实为准。
      void loadAgentSnapshot(selectedConversationRef.current, {
        showLoading: false,
      });
    };

    stream.onerror = () => {
      stream.close();
      streamRef.current = null;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (streamRunIdRef.current === runId) {
          reconnectStreamRef.current?.();
        }
      }, 1200);
    };

    for (const eventType of [
      "run.created",
      "run.status_changed",
      "run.cancellation_requested",
      "run.progress",
      "assistant.delta",
      "assistant.completed",
      "model.usage",
      "model.finished",
      "tool.started",
      "tool.completed",
    ]) {
      stream.addEventListener(eventType, handleEvent);
    }
  }, [activeRun?.id, loadAgentSnapshot]);

  useEffect(() => {
    reconnectStreamRef.current = reconnectStream;
  }, [reconnectStream]);

  useEffect(() => {
    reconnectStream();
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      streamRef.current?.close();
      streamRef.current = null;
      streamRunIdRef.current = null;
    };
  }, [reconnectStream]);

  useEffect(() => {
    if (snapshot?.runs.length) {
      const currentRevision = snapshot.runs.at(-1)?.currentRevision;
      if (typeof currentRevision === "number") {
        onRevisionChange?.(currentRevision);
      }
    }
  }, [onRevisionChange, snapshot?.runs]);

  useEffect(() => {
    if (streamingAssistantText) {
      const element = transcriptRef.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }
  }, [streamingAssistantText, snapshot?.transcript.length]);

  async function createConversation() {
    setCreatingConversation(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "新会话" }),
      });
      const body = (await response.json().catch(() => ({}))) as
        { conversation?: ConversationRecord } | AgentErrorResponse;

      if (!response.ok || !("conversation" in body) || !body.conversation) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "创建会话失败。")
            : "创建会话失败。",
        );
      }

      await loadAgentSnapshot(body.conversation.id);
      setShowHistory(false);
      draftRef.current?.focus();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "创建会话失败。",
      );
    } finally {
      setCreatingConversation(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();

    if (!message || sending || activeRun) {
      return;
    }

    setSending(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/agent-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          conversationId: selectedConversationId ?? undefined,
          message,
          locale: "zh-CN",
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        { run?: AgentRunRecord } | AgentErrorResponse;

      if (!response.ok || !("run" in body) || !body.run) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "Agent Run 创建失败。")
            : "Agent Run 创建失败。",
        );
      }

      setDraft("");
      await loadAgentSnapshot(body.run.conversationId);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Agent Run 创建失败。",
      );
    } finally {
      setSending(false);
    }
  }

  async function stopRun() {
    if (!activeRun) {
      return;
    }

    setStopping(true);

    try {
      const response = await fetch(`/api/agent-runs/${activeRun.id}/cancel`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("停止 Agent Run 失败。");
      }
      await loadAgentSnapshot(selectedConversationId, { showLoading: false });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "停止 Agent Run 失败。",
      );
    } finally {
      setStopping(false);
    }
  }

  const transcript = snapshot?.transcript ?? [];

  return (
    <aside className="agent-panel-v2" aria-label="Agent">
      <div className="agent-panel-header">
        <div>
          <span className="agent-eyebrow">
            <Bot size={14} />
            Agent workspace
          </span>
          <strong>{snapshot?.conversation.title ?? "Agent"}</strong>
        </div>
        <div className="agent-header-actions">
          <Button
            aria-label="新建会话"
            disabled={creatingConversation}
            onClick={() => void createConversation()}
            size="icon-sm"
            variant="ghost"
          >
            {creatingConversation ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <MessageSquarePlus />
            )}
          </Button>
          <Button
            aria-label="刷新 Agent 状态"
            onClick={() => void loadAgentSnapshot(selectedConversationId)}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCw />
          </Button>
        </div>
      </div>

      <div className="agent-conversation-switcher">
        <button
          aria-expanded={showHistory}
          className="agent-conversation-trigger"
          onClick={() => setShowHistory((value) => !value)}
          type="button"
        >
          <span>
            {conversations.length
              ? `${conversations.length} 个会话`
              : "暂无会话"}
          </span>
          <ChevronDown className={cn(showHistory && "rotate-180")} />
        </button>
        {showHistory ? (
          <div className="agent-conversation-menu">
            {conversations.length ? (
              conversations.map((conversation) => (
                <button
                  className={cn(
                    "agent-conversation-option",
                    conversation.id === selectedConversationId && "is-active",
                  )}
                  key={conversation.id}
                  onClick={() => {
                    setShowHistory(false);
                    void loadAgentSnapshot(conversation.id);
                  }}
                  type="button"
                >
                  <span>{conversation.title}</span>
                  {conversation.id === selectedConversationId ? (
                    <Check />
                  ) : null}
                </button>
              ))
            ) : (
              <span className="agent-menu-empty">
                发送第一条消息后会自动创建会话
              </span>
            )}
          </div>
        ) : null}
      </div>

      <div className="agent-transcript" aria-live="polite" ref={transcriptRef}>
        {loading ? (
          <div className="agent-empty-state">
            <LoaderCircle className="animate-spin" />
            <span>正在恢复 Agent 状态...</span>
          </div>
        ) : transcript.length || streamingAssistantText ? (
          <>
            {transcript.map((message) => (
              <TranscriptItem
                key={message.id ?? `${message.kind}-${message.seq}`}
                message={message}
              />
            ))}
            {streamingAssistantText ? (
              <StreamingAssistantMessage content={streamingAssistantText} />
            ) : null}
          </>
        ) : (
          <div className="agent-empty-state">
            <Bot />
            <strong>让 Agent 直接修改项目</strong>
            <span>它会先读取文件，再按 revision 安全写入。</span>
          </div>
        )}
      </div>

      {latestRun ? (
        <AgentRunStatus
          activeTool={activeTool}
          onStop={() => void stopRun()}
          run={latestRun}
          stopping={stopping}
        />
      ) : null}

      {errorMessage ? (
        <div className="agent-inline-error" role="alert">
          <TriangleAlert />
          <span>{errorMessage}</span>
        </div>
      ) : null}

      <form className="agent-composer-v2" onSubmit={sendMessage}>
        <textarea
          aria-label="给 Agent 的消息"
          disabled={Boolean(activeRun) || sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="描述你想修改的内容..."
          ref={draftRef}
          rows={3}
          value={draft}
        />
        <div className="agent-composer-footer">
          <span>DeepSeek · revision {revision}</span>
          <Button
            aria-label="发送消息"
            disabled={!draft.trim() || Boolean(activeRun) || sending}
            size="icon-sm"
            type="submit"
          >
            {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
          </Button>
        </div>
      </form>
    </aside>
  );
}

function TranscriptItem({ message }: { message: TranscriptMessage }) {
  if (message.kind === "user_message") {
    return (
      <article className="agent-message agent-message-user">
        <span className="agent-message-label">You</span>
        <p>{message.content}</p>
      </article>
    );
  }

  if (message.kind === "assistant_message") {
    return (
      <article className="agent-message agent-message-assistant">
        <span className="agent-message-label">Agent</span>
        <p>{message.content}</p>
      </article>
    );
  }

  if (message.kind === "tool_call") {
    return (
      <article className="agent-timeline-item">
        <span className="agent-timeline-icon">
          <Wrench />
        </span>
        <div>
          <strong>{message.toolName}</strong>
          <code>{formatToolArguments(message.argumentsJson)}</code>
        </div>
      </article>
    );
  }

  if (message.kind === "tool_result") {
    const ok = message.resultJson.ok === true;
    return (
      <article className={cn("agent-timeline-item", !ok && "is-error")}>
        <span className="agent-timeline-icon">
          {ok ? <Check /> : <TriangleAlert />}
        </span>
        <div>
          <strong>
            {ok
              ? `${message.toolName} completed`
              : `${message.toolName} failed`}
          </strong>
          <code>{formatToolResult(message.resultJson)}</code>
        </div>
      </article>
    );
  }

  return (
    <article className="agent-timeline-item is-system">
      <span className="agent-timeline-icon">
        <FileCode2 />
      </span>
      <div>
        <strong>{message.eventType || "System event"}</strong>
        <code>{formatToolArguments(message.data)}</code>
      </div>
    </article>
  );
}

function StreamingAssistantMessage({ content }: { content: string }) {
  return (
    <article className="agent-message agent-message-assistant is-streaming">
      <span className="agent-message-label">
        <LoaderCircle className="animate-spin" />
        Agent
      </span>
      <p>{content}</p>
    </article>
  );
}

function AgentRunStatus({
  run,
  activeTool,
  onStop,
  stopping,
}: {
  run: AgentRunRecord;
  activeTool: ToolInvocationRecord | null;
  onStop: () => void;
  stopping: boolean;
}) {
  const elapsed = formatElapsed(run);
  const status = getRunStatusCopy(run);
  const isActive = !TERMINAL_STATUSES.has(run.status);

  return (
    <section className={cn("agent-run-status", isActive && "is-active")}>
      <div className="agent-run-status-top">
        <span className="agent-run-status-label">
          {isActive ? <LoaderCircle className="animate-spin" /> : <Check />}
          {status.title}
        </span>
        <span>{elapsed}</span>
      </div>
      <div className="agent-run-status-detail">
        <span>
          {activeTool ? `正在执行 ${activeTool.toolName}` : status.detail}
        </span>
        <span>
          {run.usage.modelTurns}/{run.budget.maxModelTurns} turns · r
          {run.currentRevision}
        </span>
      </div>
      {isActive ? (
        <Button
          disabled={stopping}
          onClick={onStop}
          size="sm"
          variant="outline"
        >
          <CircleStop data-icon="inline-start" />
          {stopping ? "Stopping..." : "Stop"}
        </Button>
      ) : run.errorMessage ? (
        <p className="agent-run-error">{run.errorMessage}</p>
      ) : null}
    </section>
  );
}

function formatToolArguments(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function formatToolResult(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function formatElapsed(run: AgentRunRecord): string {
  const start =
    toTimestamp(run.startedAt) ?? toTimestamp(run.createdAt) ?? Date.now();
  const end = toTimestamp(run.completedAt) ?? Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function toTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getRunStatusCopy(run: AgentRunRecord): {
  title: string;
  detail: string;
} {
  switch (run.status) {
    case "queued":
      return { title: "Queued", detail: "等待执行器接管" };
    case "running":
      return { title: "Running", detail: "正在分析项目" };
    case "awaiting_client_tool":
      return { title: "Waiting", detail: "等待浏览器工具" };
    case "awaiting_async_job":
      return { title: "Waiting", detail: "等待异步任务" };
    case "succeeded":
      return { title: "Completed", detail: "修改已写入 Repository" };
    case "cancelled":
      return { title: "Stopped", detail: "已停止，后续 mutation 已阻断" };
    case "conflicted":
      return {
        title: "Conflict",
        detail: "检测到用户或其他执行器的新 revision",
      };
    case "budget_exhausted":
      return { title: "Budget reached", detail: "已达到本次运行预算" };
    case "failed":
      return { title: "Failed", detail: "执行过程中发生错误" };
  }
}

async function fetchAgentSnapshot(
  projectId: string,
  conversationId?: string | null,
): Promise<AgentResponse> {
  const query = conversationId
    ? `?conversationId=${encodeURIComponent(conversationId)}`
    : "";
  const response = await fetch(`/api/projects/${projectId}/agent${query}`, {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as
    AgentResponse | AgentErrorResponse;

  if (!response.ok || !("conversations" in body)) {
    throw new Error(
      "error" in body
        ? (body.error?.message ?? "无法加载 Agent 会话。")
        : "无法加载 Agent 会话。",
    );
  }

  return body;
}

function findActiveRun(runs: readonly AgentRunRecord[]): AgentRunRecord | null {
  return (
    runs
      .slice()
      .reverse()
      .find((run) => !TERMINAL_STATUSES.has(run.status)) ?? null
  );
}

function parsePersistedEvent(value: string): {
  runId: string;
  type: string;
  payload: Record<string, unknown>;
} | null {
  try {
    const parsed = JSON.parse(value) as {
      runId?: unknown;
      type?: unknown;
      payload?: unknown;
    };

    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.type !== "string" ||
      !parsed.payload ||
      typeof parsed.payload !== "object" ||
      Array.isArray(parsed.payload)
    ) {
      return null;
    }

    return {
      runId: parsed.runId,
      type: parsed.type,
      payload: parsed.payload as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}
