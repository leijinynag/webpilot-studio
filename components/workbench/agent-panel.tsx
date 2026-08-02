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
  GitCompareArrows,
  LoaderCircle,
  MessageSquarePlus,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChangeSetDialog } from "@/components/workbench/change-set-dialog";
import {
  clientToolRequestSchema,
  type ClientToolRequest,
} from "@/domains/agent/client-tools";
import { verificationFailureSchema } from "@/domains/agent/verification";
import type {
  AgentConversationSnapshot,
  AgentRunRecord,
  ConversationRecord,
  ToolInvocationRecord,
  TranscriptMessage,
  VerificationRunRecord,
  VerificationStepRecord,
} from "@/domains/agent/types";
import { projectPendingAssistantText } from "@/domains/agent/transcript";
import { toAgentLocale } from "@/infrastructure/i18n/locale";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

type AgentPanelProps = {
  projectId: string;
  revision: number;
  dirtyPaths: readonly string[];
  onClientToolRequest?: (request: ClientToolRequest) => void;
  onRevisionChange?: (revision: number) => void;
  onRestoreComplete: (revision: number) => Promise<void> | void;
};

type AgentResponse = {
  conversations: ConversationRecord[];
  snapshot: AgentConversationSnapshot | null;
};

type AgentErrorResponse = {
  error?: { message?: string };
};

type OptimisticUserMessage = {
  content: string;
  status: "sending" | "queued";
};

type Translate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "conflicted",
]);
const SNAPSHOT_REFRESH_DELAY_MS = 160;
const IMMEDIATE_SNAPSHOT_EVENT_TYPES = new Set([
  "run.created",
  "run.status_changed",
  "run.cancellation_requested",
  "assistant.completed",
  "model.turn_retried",
  "model.finished",
  "tool.completed",
  "client_tool.requested",
  "client_tool.completed",
  "client_tool.result_ignored",
  "client_tool.wait_recovered",
  "verification.completed",
  "verification.completion_blocked",
]);

export function AgentPanel({
  projectId,
  revision,
  dirtyPaths,
  onClientToolRequest,
  onRevisionChange,
  onRestoreComplete,
}: AgentPanelProps) {
  const { locale, t } = useUiI18n();
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
  const [changeSetRunId, setChangeSetRunId] = useState<string | null>(null);
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<OptimisticUserMessage | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const streamRunIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastEventIdRef = useRef(0);
  const selectedConversationRef = useRef<string | null>(null);
  const explicitConversationSelectionRef = useRef(false);
  const reconnectStreamRef = useRef<(() => void) | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const snapshotRequestRef = useRef(0);
  const snapshotRefreshTimerRef = useRef<number | null>(null);
  const snapshotRefreshInFlightRef =
    useRef<Promise<AgentResponse | null> | null>(null);
  const snapshotRefreshTrailingRef = useRef(false);
  const currentProjectIdRef = useRef(projectId);

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
  const latestRunVerifications = useMemo(
    () =>
      latestRun
        ? (snapshot?.verificationRuns.filter(
            (verification) => verification.runId === latestRun.id,
          ) ?? [])
        : [],
    [latestRun, snapshot?.verificationRuns],
  );
  const latestRunVerificationSteps = useMemo(() => {
    const verificationIds = new Set(
      latestRunVerifications.map((verification) => verification.id),
    );
    return (
      snapshot?.verificationSteps.filter((step) =>
        verificationIds.has(step.verificationRunId),
      ) ?? []
    );
  }, [latestRunVerifications, snapshot?.verificationSteps]);

  const applySnapshot = useCallback((body: AgentResponse) => {
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
    // POST 返回和随后聚合快照之间存在短暂窗口。只在数据库 Transcript 已经
    // 出现同一条用户消息后移除乐观投影，避免快照较慢时消息闪退，也避免重复展示。
    setOptimisticUserMessage((current) => {
      if (
        current &&
        body.snapshot?.transcript.some(
          (message) =>
            message.kind === "user_message" &&
            message.content === current.content,
        )
      ) {
        return null;
      }
      return current;
    });
    setErrorMessage(null);
  }, []);

  const loadAgentSnapshot = useCallback(
    async (
      conversationId?: string | null,
      options: { showLoading?: boolean } = {},
    ): Promise<AgentResponse | null> => {
      const requestId = snapshotRequestRef.current + 1;
      const requestedProjectId = projectId;
      snapshotRequestRef.current = requestId;
      if (options.showLoading !== false) {
        setLoading(true);
      }

      try {
        const body = await fetchAgentSnapshot(projectId, conversationId);
        // SSE 事件可能同时触发多个快照请求，只接受最后一次请求的结果，
        // 避免较早的慢响应覆盖刚刚到达的最新 Transcript。
        if (
          requestId === snapshotRequestRef.current &&
          requestedProjectId === currentProjectIdRef.current
        ) {
          applySnapshot(body);
        }
        return body;
      } catch (error) {
        if (
          requestId === snapshotRequestRef.current &&
          requestedProjectId === currentProjectIdRef.current
        ) {
          setErrorMessage(
            error instanceof Error ? error.message : t("agent.unableToLoad"),
          );
        }
        return null;
      } finally {
        if (
          requestId === snapshotRequestRef.current &&
          requestedProjectId === currentProjectIdRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [applySnapshot, projectId, t],
  );

  const scheduleAgentSnapshotRefresh = useCallback(
    (immediate = false) => {
      // 一个快照请求尚未结束时只记录一次 trailing refresh。SSE 可能在几十毫秒
      // 内连续送达 delta、usage、tool 事件，无需为每条事件并发读取完整 Transcript。
      if (snapshotRefreshInFlightRef.current) {
        snapshotRefreshTrailingRef.current = true;
        return;
      }

      if (snapshotRefreshTimerRef.current !== null) {
        if (!immediate) {
          return;
        }
        window.clearTimeout(snapshotRefreshTimerRef.current);
      }

      snapshotRefreshTimerRef.current = window.setTimeout(
        () => {
          snapshotRefreshTimerRef.current = null;
          const request = loadAgentSnapshot(selectedConversationRef.current, {
            showLoading: false,
          });
          snapshotRefreshInFlightRef.current = request;

          void request.finally(() => {
            if (snapshotRefreshInFlightRef.current === request) {
              snapshotRefreshInFlightRef.current = null;
            }

            if (snapshotRefreshTrailingRef.current) {
              snapshotRefreshTrailingRef.current = false;
              scheduleAgentSnapshotRefresh();
            }
          });
        },
        immediate ? 0 : SNAPSHOT_REFRESH_DELAY_MS,
      );
    },
    [loadAgentSnapshot],
  );

  const flushAgentSnapshotRefresh = useCallback(async () => {
    // 断线检查必须读取断线后的最新事实。先取消尚未开始的节流刷新，再等待在途
    // 请求结束，并额外读取一次，避免用断线前的 running 快照决定是否重连。
    if (snapshotRefreshTimerRef.current !== null) {
      window.clearTimeout(snapshotRefreshTimerRef.current);
      snapshotRefreshTimerRef.current = null;
    }
    snapshotRefreshTrailingRef.current = false;
    await snapshotRefreshInFlightRef.current;
    return loadAgentSnapshot(selectedConversationRef.current, {
      showLoading: false,
    });
  }, [loadAgentSnapshot]);

  useEffect(() => {
    // projectId 仅用于拒绝迟到的快照响应，不参与渲染。commit 后更新可避免
    // render 阶段写 ref，同时保证后面的首屏请求 effect 读取到当前项目。
    currentProjectIdRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    // 首屏加载与 SSE、切换会话、提交消息使用同一请求序列。项目切换或组件
    // 卸载时递增序号，使旧请求即使迟到也不能覆盖新项目的数据库快照。
    // 延迟到当前 effect 调用栈之外开始请求，避免同步 loading 更新形成级联渲染。
    const timerId = window.setTimeout(() => {
      // 用户可能在首屏定时器执行前已经点选了历史会话。此时默认请求不能再
      // 以“服务端最新会话”覆盖明确选择，否则有进行中 Run 的会话会停留在后台，
      // 工作台也无法恢复它等待中的 run_preview。
      if (explicitConversationSelectionRef.current) {
        return;
      }
      void loadAgentSnapshot();
    }, 0);

    return () => {
      window.clearTimeout(timerId);
      snapshotRequestRef.current += 1;
      if (snapshotRefreshTimerRef.current !== null) {
        window.clearTimeout(snapshotRefreshTimerRef.current);
        snapshotRefreshTimerRef.current = null;
      }
      snapshotRefreshTrailingRef.current = false;
      explicitConversationSelectionRef.current = false;
    };
  }, [loadAgentSnapshot]);

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
        (persistedEvent.type === "assistant.completed" ||
          persistedEvent.type === "model.turn_retried")
      ) {
        setStreamingAssistantText("");
      } else if (
        persistedEvent?.runId === runId &&
        persistedEvent.type === "client_tool.requested"
      ) {
        const requestResult = clientToolRequestSchema.safeParse(
          persistedEvent.payload,
        );
        if (requestResult.success) {
          onClientToolRequest?.(requestResult.data);
        }
      }

      // assistant.delta 先即时投影；普通高频事件进入 160ms 合并窗口，终态、
      // 客户端工具与验证事件在下一个事件循环立即收敛。数据库仍是最终事实，
      // 但不再出现“一条 SSE 对应一次完整快照 GET”的请求风暴。
      scheduleAgentSnapshotRefresh(
        Boolean(
          persistedEvent &&
          IMMEDIATE_SNAPSHOT_EVENT_TYPES.has(persistedEvent.type),
        ),
      );
    };

    stream.onerror = () => {
      stream.close();
      streamRef.current = null;

      // EventSource 无法区分“网络断线”和“服务端因 Run 已终态而主动关闭”。
      // 尤其页面刷新时，聚合快照可能恰好读到旧 Run 与新终态事件的短暂组合：
      // 游标已越过终态事件，但 UI 仍保留 running。流关闭后先强制读取一次最新
      // 数据库事实，终态则停止重连，非终态或读取失败才进入有界延迟重连。
      void flushAgentSnapshotRefresh().then((body) => {
        const refreshedActiveRun = findActiveRun(body?.snapshot?.runs ?? []);
        if (body && refreshedActiveRun?.id !== runId) {
          streamRunIdRef.current = null;
          return;
        }

        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (streamRunIdRef.current === runId) {
            reconnectStreamRef.current?.();
          }
        }, 1200);
      });
    };

    for (const eventType of [
      "run.created",
      "run.status_changed",
      "run.cancellation_requested",
      "run.progress",
      "assistant.delta",
      "assistant.completed",
      "model.turn_retried",
      "model.usage",
      "model.finished",
      "tool.started",
      "tool.completed",
      "client_tool.requested",
      "client_tool.completed",
      "client_tool.result_ignored",
      "client_tool.wait_recovered",
      "verification.completed",
      "verification.completion_blocked",
    ]) {
      stream.addEventListener(eventType, handleEvent);
    }
  }, [
    activeRun?.id,
    flushAgentSnapshotRefresh,
    onClientToolRequest,
    scheduleAgentSnapshotRefresh,
  ]);

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
      if (snapshotRefreshTimerRef.current !== null) {
        window.clearTimeout(snapshotRefreshTimerRef.current);
        snapshotRefreshTimerRef.current = null;
      }
      snapshotRefreshTrailingRef.current = false;
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
    if (!activeRun || activeRun.status !== "awaiting_client_tool") {
      return;
    }

    const invocation = snapshot?.tools
      .slice()
      .reverse()
      .find(
        (tool) =>
          tool.runId === activeRun.id &&
          tool.executionDomain === "client" &&
          tool.status === "running",
      );

    if (!invocation) {
      return;
    }

    const verificationRun =
      invocation.toolName === "browser_verify"
        ? snapshot?.verificationRuns
            .slice()
            .reverse()
            .find(
              (verification) =>
                verification.runId === activeRun.id &&
                verification.toolCallId === invocation.toolCallId,
            )
        : null;

    // browser_verify 的 verificationRunId/source/replayCount 不属于模型参数，
    // 而是服务端在 Tool Ledger 旁创建的持久化执行上下文。刷新恢复时必须从
    // verification_runs 重建，不能从 argumentsJson 猜测或生成新 ID。
    if (invocation.toolName === "browser_verify" && !verificationRun) {
      return;
    }

    // SSE 可能在页面刷新期间错过；ledger 与 Run 快照共同重建同一个请求，
    // idempotencyKey 保证恢复执行和实时事件最终指向同一项客户端工作。
    const requestResult = clientToolRequestSchema.safeParse({
      runId: activeRun.id,
      projectId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      idempotencyKey: invocation.idempotencyKey,
      revision: invocation.revisionBefore,
      arguments: invocation.argumentsJson,
      ...(verificationRun
        ? {
            verificationRunId: verificationRun.id,
            source: verificationRun.source,
            replayCount: verificationRun.replayCount,
          }
        : {}),
      ...(invocation.toolName === "git_commit"
        ? {
            author:
              activeRun.repositoryCapability.repositoryIntent?.commitAuthor,
          }
        : {}),
      ...(isBrowserRepositoryFileMutation(invocation.toolName)
        ? {
            readBeforeMutation: hasSuccessfulReadBeforeMutation({
              invocation,
              tools: snapshot?.tools ?? [],
            }),
          }
        : {}),
    });

    if (requestResult.success) {
      onClientToolRequest?.(requestResult.data);
    }
  }, [
    activeRun,
    onClientToolRequest,
    projectId,
    snapshot?.tools,
    snapshot?.verificationRuns,
  ]);

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
        body: JSON.stringify({ title: t("agent.createConversation") }),
      });
      const body = (await response.json().catch(() => ({}))) as
        { conversation?: ConversationRecord } | AgentErrorResponse;

      if (!response.ok || !("conversation" in body) || !body.conversation) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? t("agent.createConversationFailed"))
            : t("agent.createConversationFailed"),
        );
      }

      selectConversation(body.conversation.id);
      await loadAgentSnapshot(body.conversation.id);
      setShowHistory(false);
      draftRef.current?.focus();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("agent.createConversationFailed"),
      );
    } finally {
      setCreatingConversation(false);
    }
  }

  function selectConversation(conversationId: string) {
    // ref 必须在发请求前同步更新。setState 只会在下一次 commit 后生效，
    // 若这段窗口内 SSE 断线重拉或首屏定时器启动，旧 selectedConversationId
    // 会把请求重新指向另一个会话。
    explicitConversationSelectionRef.current = true;
    selectedConversationRef.current = conversationId;
    setSelectedConversationId(conversationId);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();

    if (!message || sending || activeRun) {
      return;
    }

    // 用户消息先进入本地投影并立即清空输入框。网络、数据库限流检查和 Run
    // 事务都不再阻塞可见反馈；失败时再把原文恢复到编辑框供用户重试。
    setDraft("");
    setOptimisticUserMessage({ content: message, status: "sending" });
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
          locale: toAgentLocale(locale),
          repositoryRevision: revision,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        { run?: AgentRunRecord } | AgentErrorResponse;

      if (!response.ok || !("run" in body) || !body.run) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? t("agent.runCreateFailed"))
            : t("agent.runCreateFailed"),
        );
      }

      setOptimisticUserMessage((current) =>
        current?.content === message
          ? { ...current, status: "queued" }
          : current,
      );
      // SSE 会持续收敛后续状态；这里触发一次首个持久化快照，但不让输入交互
      // 等待额外的 GET 往返。sending 只代表创建 Run 的 POST 是否仍在进行。
      void loadAgentSnapshot(body.run.conversationId, { showLoading: false });
    } catch (error) {
      setOptimisticUserMessage((current) =>
        current?.content === message ? null : current,
      );
      setDraft((current) => (current.trim() ? current : message));
      setErrorMessage(
        error instanceof Error ? error.message : t("agent.runCreateFailed"),
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
        throw new Error(t("agent.stopFailed"));
      }
      await loadAgentSnapshot(selectedConversationId, { showLoading: false });
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("agent.stopFailed"),
      );
    } finally {
      setStopping(false);
    }
  }

  const transcript = snapshot?.transcript ?? [];
  const showOptimisticUserMessage =
    optimisticUserMessage !== null &&
    !transcript.some(
      (message) =>
        message.kind === "user_message" &&
        message.content === optimisticUserMessage.content,
    );

  return (
    <aside className="agent-panel-v2" aria-label={t("agent.aria")}>
      <div className="agent-panel-header">
        <div>
          <span className="agent-eyebrow">
            <Bot size={14} />
            {t("agent.workspace")}
          </span>
          <strong>
            {snapshot?.conversation.title ?? t("agent.assistant")}
          </strong>
        </div>
        <div className="agent-header-actions">
          <Button
            aria-label={t("agent.newConversation")}
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
            aria-label={t("agent.refresh")}
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
              ? t("agent.conversationCount", { count: conversations.length })
              : t("agent.noConversations")}
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
                    selectConversation(conversation.id);
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
                {t("agent.conversationEmpty")}
              </span>
            )}
          </div>
        ) : null}
      </div>

      <div className="agent-transcript" aria-live="polite" ref={transcriptRef}>
        {loading ? (
          <div className="agent-empty-state">
            <LoaderCircle className="animate-spin" />
            <span>{t("agent.restoreStatus")}</span>
          </div>
        ) : transcript.length ||
          showOptimisticUserMessage ||
          streamingAssistantText ? (
          <>
            {transcript.map((message) => (
              <TranscriptItem
                key={message.id ?? `${message.kind}-${message.seq}`}
                message={message}
              />
            ))}
            {showOptimisticUserMessage && optimisticUserMessage ? (
              <OptimisticTranscriptItem message={optimisticUserMessage} />
            ) : null}
            {streamingAssistantText ? (
              <StreamingAssistantMessage content={streamingAssistantText} />
            ) : null}
          </>
        ) : (
          <div className="agent-empty-state">
            <Bot />
            <strong>{t("agent.emptyTitle")}</strong>
            <span>{t("agent.emptyDescription")}</span>
          </div>
        )}
      </div>

      {latestRun ? (
        <AgentRunStatus
          activeTool={activeTool}
          hasStreamingAssistantText={Boolean(streamingAssistantText)}
          onReviewChanges={() => setChangeSetRunId(latestRun.id)}
          onStop={() => void stopRun()}
          run={latestRun}
          stopping={stopping}
          verificationRuns={latestRunVerifications}
          verificationSteps={latestRunVerificationSteps}
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
          aria-label={t("agent.messageLabel")}
          disabled={Boolean(activeRun) || sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={t("agent.placeholder")}
          ref={draftRef}
          rows={3}
          value={draft}
        />
        <div className="agent-composer-footer">
          <span>{t("agent.provider", { revision })}</span>
          <Button
            aria-label={t("agent.send")}
            disabled={!draft.trim() || Boolean(activeRun) || sending}
            size="icon-sm"
            type="submit"
          >
            {sending ? <LoaderCircle className="animate-spin" /> : <Send />}
          </Button>
        </div>
      </form>

      {changeSetRunId ? (
        <ChangeSetDialog
          dirtyPaths={dirtyPaths}
          key={changeSetRunId}
          onOpenChange={(open) => {
            if (!open) {
              setChangeSetRunId(null);
            }
          }}
          onRestoreComplete={onRestoreComplete}
          runId={changeSetRunId}
        />
      ) : null}
    </aside>
  );
}

function TranscriptItem({ message }: { message: TranscriptMessage }) {
  const { t } = useUiI18n();

  if (message.kind === "user_message") {
    return (
      <article className="agent-message agent-message-user">
        <span className="agent-message-label">{t("agent.you")}</span>
        <p>{message.content}</p>
      </article>
    );
  }

  if (message.kind === "assistant_message") {
    return (
      <article className="agent-message agent-message-assistant">
        <span className="agent-message-label">{t("agent.assistant")}</span>
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
    const preview = getPreviewResultDisplay(message);
    return (
      <article className={cn("agent-timeline-item", !ok && "is-error")}>
        <span className="agent-timeline-icon">
          {ok ? <Check /> : <TriangleAlert />}
        </span>
        <div>
          <strong>
            {preview
              ? t(ok ? "agent.previewPassed" : "agent.previewFailed", {
                  revision: preview.revision,
                })
              : ok
                ? t("agent.toolCompleted", { tool: message.toolName })
                : t("agent.toolFailed", { tool: message.toolName })}
          </strong>
          {preview ? (
            <>
              <p className="agent-preview-summary">{preview.summary}</p>
              <div className="agent-preview-evidence">
                <span>install {preview.install}</span>
                <span>server {preview.devServer}</span>
                <span>runtime {preview.runtime}</span>
                <span>console {preview.consoleErrors}</span>
              </div>
              {preview.failureMessage ? (
                <code>{preview.failureMessage}</code>
              ) : null}
            </>
          ) : (
            <code>{formatToolResult(message.resultJson)}</code>
          )}
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
        <strong>{message.eventType || t("agent.systemEvent")}</strong>
        <code>{formatToolArguments(message.data)}</code>
      </div>
    </article>
  );
}

function OptimisticTranscriptItem({
  message,
}: {
  message: OptimisticUserMessage;
}) {
  const { t } = useUiI18n();

  return (
    <article
      className="agent-message agent-message-user is-pending"
      data-testid="optimistic-user-message"
    >
      <span className="agent-message-label">
        {t("agent.you")} ·{" "}
        {message.status === "sending"
          ? t("agent.sendingLabel")
          : t("agent.queuedLabel")}
      </span>
      <p>{message.content}</p>
    </article>
  );
}

function StreamingAssistantMessage({ content }: { content: string }) {
  const { t } = useUiI18n();

  return (
    <article className="agent-message agent-message-assistant is-streaming">
      <span className="agent-message-label">
        <LoaderCircle className="animate-spin" />
        {t("agent.assistant")}
      </span>
      <p>{content}</p>
    </article>
  );
}

function AgentRunStatus({
  run,
  activeTool,
  hasStreamingAssistantText,
  onReviewChanges,
  onStop,
  stopping,
  verificationRuns,
  verificationSteps,
}: {
  run: AgentRunRecord;
  activeTool: ToolInvocationRecord | null;
  hasStreamingAssistantText: boolean;
  onReviewChanges: () => void;
  onStop: () => void;
  stopping: boolean;
  verificationRuns: VerificationRunRecord[];
  verificationSteps: VerificationStepRecord[];
}) {
  const { t } = useUiI18n();
  const elapsed = formatElapsed(run);
  const status = getRunStatusCopy(run, t);
  const isActive = !TERMINAL_STATUSES.has(run.status);
  const isFailure = status.tone === "error";
  const displayedModelTurns =
    run.status === "running" && !activeTool
      ? Math.min(run.usage.modelTurns + 1, run.budget.maxModelTurns)
      : run.usage.modelTurns;
  const activeDetail = activeTool
    ? t("agent.executingTool", { tool: activeTool.toolName })
    : run.status === "running" && hasStreamingAssistantText
      ? t("agent.modelResponding")
      : status.detail;

  return (
    <section
      className={cn(
        "agent-run-status",
        isActive && "is-active",
        `is-${status.tone}`,
      )}
    >
      <div className="agent-run-status-top">
        <span className="agent-run-status-label">
          {isActive ? (
            <LoaderCircle className="animate-spin" />
          ) : isFailure ? (
            <TriangleAlert />
          ) : (
            <Check />
          )}
          {status.title}
        </span>
        <span>{elapsed}</span>
      </div>
      <div className="agent-run-status-detail">
        <span>{activeDetail}</span>
        <span>
          {displayedModelTurns}/{run.budget.maxModelTurns} {t("agent.turns")} ·
          r{run.currentRevision}
        </span>
      </div>
      <div className="agent-run-metrics" aria-label={t("agent.runMetrics")}>
        <span>
          <PlayCircle />
          <b>{run.usage.clientResumes}</b>/{run.budget.maxClientResumes}{" "}
          {t("agent.previews")}
        </span>
        <span>
          <RotateCcw />
          <b>{run.usage.repairRounds}</b> {t("agent.repairs")}
        </span>
        <span>
          <Wrench />
          <b>{run.usage.fileMutations}</b>/{run.budget.maxFileMutations}{" "}
          {t("agent.writes")}
        </span>
      </div>
      {run.usage.latestVerificationRevision !== null ? (
        <div
          className={cn(
            "agent-verification-state",
            run.usage.latestVerificationOk ? "is-verified" : "is-unverified",
          )}
        >
          {run.usage.latestVerificationOk ? <ShieldCheck /> : <TriangleAlert />}
          <span>
            {run.usage.latestVerificationOk
              ? t("agent.verifiedRevision", {
                  revision: run.usage.latestVerificationRevision,
                })
              : t("agent.verificationFailed", {
                  revision: run.usage.latestVerificationRevision,
                })}
          </span>
          {run.usage.firstPreviewDurationMs !== null ? (
            <small>
              {t("agent.firstPreview", {
                duration: formatDuration(run.usage.firstPreviewDurationMs),
              })}
            </small>
          ) : null}
        </div>
      ) : null}
      {verificationRuns.length ? (
        <VerificationHistory
          runs={verificationRuns}
          steps={verificationSteps}
        />
      ) : null}
      {isActive ? (
        <Button
          disabled={stopping}
          onClick={onStop}
          size="sm"
          variant="outline"
        >
          <CircleStop data-icon="inline-start" />
          {stopping ? t("agent.stopping") : t("agent.stop")}
        </Button>
      ) : (
        <>
          <p className="agent-run-error">{status.message}</p>
          {run.status === "succeeded" ? (
            <Button onClick={onReviewChanges} size="sm" variant="outline">
              <GitCompareArrows data-icon="inline-start" />
              {t("agent.reviewChanges")}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}

type VerificationCheckField =
  | "buildOk"
  | "runtimeOk"
  | "consoleOk"
  | "networkOk"
  | "actionsOk"
  | "assertionsOk"
  | "revisionOk";

const VERIFICATION_CHECKS = [
  ["buildOk", "Build"],
  ["runtimeOk", "Runtime"],
  ["consoleOk", "Console"],
  ["networkOk", "Network"],
  ["actionsOk", "Actions"],
  ["assertionsOk", "Assertions"],
  ["revisionOk", "Revision"],
] as const satisfies ReadonlyArray<readonly [VerificationCheckField, string]>;

function VerificationHistory({
  runs,
  steps,
}: {
  runs: VerificationRunRecord[];
  steps: VerificationStepRecord[];
}) {
  const { t } = useUiI18n();
  const stepsByRun = new Map<string, VerificationStepRecord[]>();
  for (const step of steps) {
    const current = stepsByRun.get(step.verificationRunId) ?? [];
    current.push(step);
    stepsByRun.set(step.verificationRunId, current);
  }

  // 最新验证放在最上方，旧失败与自动回放仍保留为可审计记录。限制为最近
  // 四轮，避免长修复循环挤压消息区；完整事实仍保存在数据库快照中。
  const visibleRuns = runs.slice(-4).reverse();

  return (
    <details
      className="agent-verification-history"
      open={visibleRuns[0]?.status === "failed"}
    >
      <summary>
        <span>{t("agent.verificationHistory")}</span>
        <small>{t("agent.verificationCount", { count: runs.length })}</small>
      </summary>
      <div className="agent-verification-runs">
        {visibleRuns.map((verification) => {
          const runSteps = (stepsByRun.get(verification.id) ?? [])
            .slice()
            .sort((left, right) => left.stepIndex - right.stepIndex);
          const sourceLabel =
            verification.source === "replay"
              ? t("agent.replay")
              : t("agent.assistant");

          return (
            <article
              className={cn(
                "agent-verification-run",
                `is-${verification.status}`,
              )}
              key={verification.id}
            >
              <header>
                <span>
                  {verification.status === "passed" ? (
                    <ShieldCheck />
                  ) : verification.status === "failed" ? (
                    <TriangleAlert />
                  ) : (
                    <LoaderCircle
                      className={cn(
                        verification.status === "running" && "animate-spin",
                      )}
                    />
                  )}
                  r{verification.revision} · {sourceLabel}
                </span>
                <small>
                  replay {verification.replayCount} · {verification.status}
                </small>
              </header>

              <div
                aria-label={t("agent.verificationGate", {
                  revision: verification.revision,
                })}
                className="agent-verification-checks"
              >
                {VERIFICATION_CHECKS.map(([field, label]) => {
                  const value = verification[field];
                  return (
                    <span
                      className={cn(
                        value === true && "is-passed",
                        value === false && "is-failed",
                      )}
                      key={field}
                    >
                      {value === true ? (
                        <Check />
                      ) : value === false ? (
                        <TriangleAlert />
                      ) : (
                        <span aria-hidden="true" className="check-pending" />
                      )}
                      {label}
                    </span>
                  );
                })}
              </div>

              {runSteps.length ? (
                <ol className="agent-verification-steps">
                  {runSteps.map((step) => (
                    <li
                      className={cn(step.status === "failed" && "is-failed")}
                      key={step.id}
                    >
                      <span>{step.stepIndex + 1}</span>
                      <div>
                        <strong>{formatBrowserAction(step.action, t)}</strong>
                        <small>
                          {step.message} · {formatDuration(step.durationMs)}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="agent-verification-pending">
                  {t("agent.waitingEvidence")}
                </p>
              )}

              {verification.summary ? (
                <p className="agent-verification-summary">
                  {verification.failedStep === null
                    ? verification.summary
                    : t("agent.failureStep", {
                        step: verification.failedStep + 1,
                        summary: verification.summary,
                      })}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </details>
  );
}

function formatBrowserAction(action: string, t: Translate): string {
  const labels: Record<string, string> = {
    click: t("agent.actionClick"),
    fill: t("agent.actionFill"),
    select: t("agent.actionSelect"),
    press: t("agent.actionPress"),
    wait_for: t("agent.actionWait"),
    assert_text: t("agent.actionAssertText"),
    assert_visible: t("agent.actionAssertVisible"),
    assert_url: t("agent.actionAssertUrl"),
  };
  return labels[action] ?? action;
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

function getRunStatusCopy(
  run: AgentRunRecord,
  t: Translate,
): {
  title: string;
  detail: string;
  message: string;
  tone: "neutral" | "success" | "warning" | "error";
} {
  switch (run.status) {
    case "queued":
      return {
        title: t("agent.statusQueued"),
        detail: t("agent.statusQueuedDetail"),
        message: t("agent.statusQueuedMessage"),
        tone: "neutral",
      };
    case "running":
      return {
        title: t("agent.statusRunning"),
        detail: t("agent.statusRunningDetail"),
        message: t("agent.statusRunningMessage"),
        tone: "neutral",
      };
    case "awaiting_client_tool":
      return {
        title: t("agent.statusAwaitingTool"),
        detail: t("agent.statusAwaitingToolDetail"),
        message: t("agent.statusAwaitingToolMessage"),
        tone: "neutral",
      };
    case "awaiting_async_job":
      return {
        title: t("agent.statusAwaitingJob"),
        detail: t("agent.statusAwaitingJobDetail"),
        message: t("agent.statusAwaitingJobMessage"),
        tone: "neutral",
      };
    case "succeeded":
      return {
        title: t("agent.statusSucceeded"),
        detail: t("agent.statusSucceededDetail"),
        message: t("agent.statusSucceededMessage"),
        tone: "success",
      };
    case "cancelled":
      return {
        title: t("agent.statusCancelled"),
        detail: t("agent.statusCancelledDetail"),
        message: t("agent.statusCancelledMessage"),
        tone: "warning",
      };
    case "conflicted":
      return {
        title: t("agent.statusConflicted"),
        detail: t("agent.statusConflictedDetail", {
          revision: run.currentRevision,
        }),
        message: t("agent.statusConflictedMessage"),
        tone: "warning",
      };
    case "budget_exhausted":
      if (run.errorCode === "AGENT_NO_PROGRESS") {
        return {
          title: t("agent.statusNoProgress"),
          detail: t("agent.statusNoProgressDetail"),
          message: t("agent.statusNoProgressMessage"),
          tone: "warning",
        };
      }
      return {
        title: t("agent.statusBudget"),
        detail: t("agent.statusBudgetDetail"),
        message: t("agent.statusBudgetMessage"),
        tone: "warning",
      };
    case "failed":
      return getFailedRunStatusCopy(run.errorCode, t);
  }
}

function getPreviewResultDisplay(
  message: Extract<TranscriptMessage, { kind: "tool_result" }>,
): {
  revision: number;
  summary: string;
  install: string;
  devServer: string;
  runtime: string;
  consoleErrors: number;
  failureMessage: string | null;
} | null {
  if (message.toolName !== "run_preview") {
    return null;
  }

  const result = message.resultJson;
  const build = asRecord(result.build);
  const install = asRecord(build.install);
  const devServer = asRecord(build.devServer);
  const runtime = asRecord(result.runtime);
  const consoleEvidence = asRecord(result.console);
  const consoleEntries = Array.isArray(consoleEvidence.entries)
    ? consoleEvidence.entries
    : [];
  const failure = verificationFailureSchema.safeParse(
    result.verificationFailure,
  );

  return {
    revision: typeof result.revision === "number" ? result.revision : 0,
    summary:
      typeof result.summary === "string" ? result.summary : "预览结果已返回。",
    install: typeof install.status === "string" ? install.status : "unknown",
    devServer:
      typeof devServer.status === "string" ? devServer.status : "unknown",
    runtime: runtime.rendered === true ? "rendered" : "failed",
    consoleErrors: consoleEntries.filter(
      (entry) => asRecord(entry).level === "error",
    ).length,
    failureMessage: failure.success
      ? (failure.data.issues[0]?.message ?? failure.data.summary)
      : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${milliseconds}ms`;
  }
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function getFailedRunStatusCopy(
  errorCode: string | null,
  t: Translate,
): {
  title: string;
  detail: string;
  message: string;
  tone: "error";
} {
  switch (errorCode) {
    case "AGENT_PROVIDER_NOT_CONFIGURED":
      return {
        title: t("agent.statusProviderConfig"),
        detail: t("agent.statusProviderConfigDetail"),
        message: t("agent.statusProviderConfigMessage"),
        tone: "error",
      };
    case "AGENT_PROVIDER_TIMEOUT":
      return {
        title: t("agent.statusProviderTimeout"),
        detail: t("agent.statusProviderTimeoutDetail"),
        message: t("agent.statusProviderTimeoutMessage"),
        tone: "error",
      };
    case "AGENT_PROVIDER_RATE_LIMITED":
      return {
        title: t("agent.statusProviderRateLimit"),
        detail: t("agent.statusProviderRateLimitDetail"),
        message: t("agent.statusProviderRateLimitMessage"),
        tone: "error",
      };
    case "AGENT_PROVIDER_INVALID_STREAM":
      return {
        title: t("agent.statusProviderInvalidStream"),
        detail: t("agent.statusProviderInvalidStreamDetail"),
        message: t("agent.statusProviderInvalidStreamMessage"),
        tone: "error",
      };
    case "AGENT_PROFILE_UNAVAILABLE":
      return {
        title: t("agent.statusProfileUnavailable"),
        detail: t("agent.statusProfileUnavailableDetail"),
        message: t("agent.statusProfileUnavailableMessage"),
        tone: "error",
      };
    default:
      return {
        title: t("agent.statusFailed"),
        detail: t("agent.statusFailedDetail"),
        message: t("agent.statusFailedMessage"),
        tone: "error",
      };
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

function isBrowserRepositoryFileMutation(toolName: string): boolean {
  return (
    toolName === "write_file" ||
    toolName === "delete_file" ||
    toolName === "rename_file"
  );
}

/**
 * read-before-mutation 是 Run + revision 级执行事实，刷新后不能默认放行。
 * 这里只接受同一 Run、同一 revision、同一路径且已成功的 read_file ledger。
 */
function hasSuccessfulReadBeforeMutation(input: {
  invocation: ToolInvocationRecord;
  tools: readonly ToolInvocationRecord[];
}): boolean {
  const path =
    input.invocation.toolName === "rename_file"
      ? input.invocation.argumentsJson.fromPath
      : input.invocation.argumentsJson.path;

  if (typeof path !== "string") {
    return false;
  }

  return input.tools.some(
    (tool) =>
      tool.runId === input.invocation.runId &&
      tool.toolName === "read_file" &&
      tool.status === "succeeded" &&
      tool.revisionBefore === input.invocation.revisionBefore &&
      tool.argumentsJson.path === path,
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
