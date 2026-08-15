"use client";

import {
  Children,
  FormEvent,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  ComponentPropsWithoutRef,
  ReactElement,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  FileCode2,
  GitCompareArrows,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Trash2,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { browserApiFetch } from "@/infrastructure/http/browser-api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChangeSetDialog } from "@/components/workbench/change-set-dialog";
import {
  clientToolRequestSchema,
  type ClientToolRequest,
} from "@/domains/agent/client-tools";
import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import { verificationFailureSchema } from "@/domains/agent/verification";
import type {
  AgentConversationSnapshot,
  AgentRunEvent,
  AgentRunRecord,
  ConversationRecord,
  ToolInvocationRecord,
  TranscriptMessage,
  VerificationRunRecord,
  VerificationStepRecord,
} from "@/domains/agent/types";
import {
  IMAGE_ONLY_MESSAGE_CONTENT,
  isImageOnlyMessageContent,
} from "@/domains/agent/message-content";
import { projectPendingAssistantText } from "@/domains/agent/transcript";
import { toAgentLocale } from "@/infrastructure/i18n/locale";
import { useUiI18n } from "@/infrastructure/i18n/ui";
import { cn } from "@/lib/utils";

type AgentPanelProps = {
  projectId: string;
  revision: number;
  dirtyPaths: readonly string[];
  onClientToolRequest?: (request: ClientToolRequest) => void;
  onFileStreamEvents?: (
    conversationId: string,
    events: readonly AgentRunEvent[],
  ) => void;
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
  attachmentIds?: string[];
  status: "sending" | "queued";
};

type AttachmentView = {
  id: string;
  originalFilename: string;
  mimeType: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  status: string;
  createdAt: string;
};

type AgentModelOption = {
  id: string;
  label: string;
  tier: "agent" | "fast";
};

type AssetView = {
  id: string;
  kind: string;
  source: string;
  attachmentId: string | null;
  imageRunId: string | null;
  originalFilename: string | null;
  mimeType: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  createdAt: string;
};

type PendingAttachment = {
  clientId: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
  progress: number;
  attachment: AttachmentView | null;
  error: string | null;
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
const STREAMING_DELTA_FLUSH_DELAY_MS = 32;
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
const FILE_PROJECTION_EVENT_TYPES = new Set([
  "file.stream_started",
  "file.stream_delta",
  "file.stream_completed",
  "file.stream_discarded",
  "tool.completed",
]);
const FILE_STREAM_EVENT_TYPES = new Set([
  "file.stream_started",
  "file.stream_delta",
  "file.stream_completed",
  "file.stream_discarded",
]);
const MAX_AGENT_SNAPSHOT_CACHE_ENTRIES = 16;
const LATEST_CONVERSATION_CACHE_KEY = "__latest__";
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 40;

/**
 * 这层缓存只优化同一浏览器标签页内的返回体验。
 *
 * PostgreSQL 中的 Conversation、AgentRun、Transcript 与 Tool Ledger 仍是最终事实；
 * 页面挂载后一定会后台重验证。缓存不进入 localStorage，也不会跨浏览器刷新恢复，
 * 这样既避免把可能含用户代码的对话长期写入浏览器，也不会制造第二份持久化真相。
 */
const agentSnapshotCache = new Map<string, AgentResponse>();

export function clearAgentSnapshotCache(): void {
  agentSnapshotCache.clear();
}

export function AgentPanel({
  projectId,
  revision,
  dirtyPaths,
  onClientToolRequest,
  onFileStreamEvents,
  onRevisionChange,
  onRestoreComplete,
}: AgentPanelProps) {
  const { locale, t } = useUiI18n();
  const [initialAgentResponse] = useState(() =>
    readAgentSnapshotCache(projectId),
  );
  const [conversations, setConversations] = useState<ConversationRecord[]>(
    () => initialAgentResponse?.conversations ?? [],
  );
  const [snapshot, setSnapshot] = useState<AgentConversationSnapshot | null>(
    () => initialAgentResponse?.snapshot ?? null,
  );
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(() => initialAgentResponse?.snapshot?.conversation.id ?? null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(() => initialAgentResponse === null);
  const [sending, setSending] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [changeSetRunId, setChangeSetRunId] = useState<string | null>(null);
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [optimisticUserMessage, setOptimisticUserMessage] =
    useState<OptimisticUserMessage | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [modelOptions, setModelOptions] = useState<AgentModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [showAssets, setShowAssets] = useState(false);
  const streamRef = useRef<EventSource | null>(null);
  const streamRunIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastEventIdRef = useRef(
    getLatestAgentEventSequence(initialAgentResponse?.snapshot),
  );
  const selectedConversationRef = useRef<string | null>(
    initialAgentResponse?.snapshot?.conversation.id ?? null,
  );
  const explicitConversationSelectionRef = useRef(false);
  const reconnectStreamRef = useRef<(() => void) | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptPinnedToBottomRef = useRef(true);
  const transcriptScrollMetricsRef = useRef({
    scrollHeight: 0,
    scrollTop: 0,
  });
  const transcriptContextKeyRef = useRef<string | null>(null);
  const snapshotRequestRef = useRef(0);
  const snapshotRefreshTimerRef = useRef<number | null>(null);
  const snapshotRefreshInFlightRef =
    useRef<Promise<AgentResponse | null> | null>(null);
  const snapshotRefreshTrailingRef = useRef(false);
  const streamingDeltaBufferRef = useRef("");
  const streamingFlushTimerRef = useRef<number | null>(null);
  const currentProjectIdRef = useRef(projectId);
  const renderedProjectIdRef = useRef(projectId);
  const hasUploadingAttachment = pendingAttachments.some(
    (attachment) => attachment.status === "uploading",
  );
  const hasReadyAttachment = pendingAttachments.some(
    (attachment) =>
      attachment.status === "ready" && attachment.attachment !== null,
  );

  const clearStreamingDeltaBuffer = useCallback(() => {
    if (streamingFlushTimerRef.current !== null) {
      window.clearTimeout(streamingFlushTimerRef.current);
      streamingFlushTimerRef.current = null;
    }
    streamingDeltaBufferRef.current = "";
  }, []);

  const flushStreamingDeltaBuffer = useCallback(() => {
    streamingFlushTimerRef.current = null;
    const bufferedText = streamingDeltaBufferRef.current;
    streamingDeltaBufferRef.current = "";

    if (bufferedText) {
      setStreamingAssistantText((current) => current + bufferedText);
    }
  }, []);

  const queueStreamingDelta = useCallback(
    (delta: string) => {
      streamingDeltaBufferRef.current += delta;
      if (streamingFlushTimerRef.current !== null) {
        return;
      }

      // 模型可能在一个动画帧内送来多条极小 delta。先在 ref 中合并，再以
      // 约 30fps 提交 React state，可明显减少 Markdown 重解析、布局抖动和
      // 滚动补偿次数，同时仍保持用户感知上的实时输出。
      streamingFlushTimerRef.current = window.setTimeout(
        flushStreamingDeltaBuffer,
        STREAMING_DELTA_FLUSH_DELAY_MS,
      );
    },
    [flushStreamingDeltaBuffer],
  );

  useLayoutEffect(() => {
    if (renderedProjectIdRef.current === projectId) {
      return;
    }

    renderedProjectIdRef.current = projectId;
    const cached = readAgentSnapshotCache(projectId);

    // 路由框架通常会重建工作台，但测试、未来的并行路由或上层状态保持也可能
    // 复用同一组件实例。项目身份变化必须在浏览器绘制前切换快照，绝不能让
    // 上一个项目的 Transcript、Run 状态或 SSE 游标短暂出现在新项目中。
    setConversations(cached?.conversations ?? []);
    setSnapshot(cached?.snapshot ?? null);
    setSelectedConversationId(cached?.snapshot?.conversation.id ?? null);
    selectedConversationRef.current = cached?.snapshot?.conversation.id ?? null;
    clearStreamingDeltaBuffer();
    setStreamingAssistantText("");
    setOptimisticUserMessage(null);
    setErrorMessage(null);
    setLoading(cached === null);
    lastEventIdRef.current = getLatestAgentEventSequence(cached?.snapshot);
    transcriptContextKeyRef.current = null;
    transcriptPinnedToBottomRef.current = true;
    transcriptScrollMetricsRef.current = {
      scrollHeight: 0,
      scrollTop: 0,
    };
  }, [clearStreamingDeltaBuffer, projectId]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    // Object URL 只服务于当前 Composer。项目切换或组件卸载时统一回收，
    // 避免用户反复粘贴/选择图片后，浏览器内存持续增长。
    return () => {
      for (const item of pendingAttachmentsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    void browserApiFetch("/api/agent-models", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        return (await response.json()) as { models?: AgentModelOption[] };
      })
      .then((body) => {
        if (cancelled) {
          return;
        }
        const options = (body?.models ?? []).filter(
          (option): option is AgentModelOption =>
            typeof option?.id === "string" &&
            typeof option.label === "string" &&
            (option.tier === "agent" || option.tier === "fast"),
        );
        setModelOptions(options);
        setSelectedModel((current) =>
          current && options.some((option) => option.id === current)
            ? current
            : (options[0]?.id ?? ""),
        );
      })
      .catch(() => {
        // 模型列表是辅助配置，加载失败时仍允许页面展示和输入。
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadAssets = useCallback(async () => {
    try {
      const response = await browserApiFetch(
        `/api/projects/${projectId}/assets`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { assets?: AssetView[] };
      setAssets(body.assets ?? []);
    } catch {
      // 资产面板是辅助能力，加载失败不应阻断聊天主流程。
    }
  }, [projectId]);

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

  const applySnapshot = useCallback(
    (body: AgentResponse) => {
      // 聚合快照已经包含当前 Run 的全部持久化 delta。先丢弃尚未提交到视图的
      // 本地 buffer，再从数据库事件重建，避免同一段文本被重复追加。
      clearStreamingDeltaBuffer();
      writeAgentSnapshotCache(projectId, body);
      setConversations(body.conversations);
      setSnapshot(body.snapshot);
      setSelectedConversationId(body.snapshot?.conversation.id ?? null);
      if (body.snapshot) {
        // Snapshot 用于页面刷新、断线重连和切换会话后的恢复。这里把完整事件
        // 交给工作台投影层；投影层以 runId + sequence 去重，因此可以同时接收
        // SSE 与历史快照，而不会重复追加代码或重新打开用户已关闭的临时文件。
        onFileStreamEvents?.(
          body.snapshot.conversation.id,
          body.snapshot.events,
        );
      }
      const activeSnapshotRun = findActiveRun(body.snapshot?.runs ?? []);
      setStreamingAssistantText(
        projectPendingAssistantText(
          body.snapshot?.events ?? [],
          activeSnapshotRun?.id ?? null,
        ),
      );
      lastEventIdRef.current = getLatestAgentEventSequence(body.snapshot);
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
    },
    [clearStreamingDeltaBuffer, onFileStreamEvents, projectId],
  );

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
    function scheduleSnapshotRefresh(immediate = false) {
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
              scheduleSnapshotRefresh();
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
      void loadAgentSnapshot(undefined, {
        // 命中标签页缓存时保留现有 Transcript，只在后台重验证。未命中时仍展示
        // 明确的恢复状态，避免把真正的首屏网络等待伪装成空会话。
        showLoading: readAgentSnapshotCache(projectId) === null,
      });
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
  }, [loadAgentSnapshot, projectId]);

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
        FILE_PROJECTION_EVENT_TYPES.has(persistedEvent.type)
      ) {
        const conversationId = selectedConversationRef.current;
        if (conversationId) {
          // 高频文件 delta 必须在到达浏览器后直接投影，不能等待完整快照。
          // 正式 tool.completed 也走同一通道，让临时标签进入 Repository 交接态。
          onFileStreamEvents?.(conversationId, [persistedEvent]);
        }
      }

      if (
        persistedEvent?.runId === runId &&
        persistedEvent.type === "assistant.delta" &&
        typeof persistedEvent.payload.text === "string"
      ) {
        queueStreamingDelta(persistedEvent.payload.text);
      } else if (
        persistedEvent?.runId === runId &&
        (persistedEvent.type === "assistant.completed" ||
          persistedEvent.type === "model.turn_retried")
      ) {
        clearStreamingDeltaBuffer();
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

      if (
        persistedEvent?.runId === runId &&
        persistedEvent.type === "tool.completed" &&
        persistedEvent.payload.toolName === "generate_image"
      ) {
        void loadAssets();
      }

      if (persistedEvent && FILE_STREAM_EVENT_TYPES.has(persistedEvent.type)) {
        // 临时文件内容已经由 SSE 即时呈现。若每个几十字符的 delta 都读取完整
        // Conversation 快照，会放大数据库和网络开销，也会让 Monaco 展示反而变慢。
        return;
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
      "file.stream_started",
      "file.stream_delta",
      "file.stream_completed",
      "file.stream_discarded",
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
    clearStreamingDeltaBuffer,
    flushAgentSnapshotRefresh,
    onClientToolRequest,
    onFileStreamEvents,
    loadAssets,
    queueStreamingDelta,
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
      clearStreamingDeltaBuffer();
      streamRef.current?.close();
      streamRef.current = null;
      streamRunIdRef.current = null;
    };
  }, [clearStreamingDeltaBuffer, reconnectStream]);

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

  const transcriptContextKey = `${projectId}:${
    selectedConversationId ?? "latest"
  }`;
  const transcriptLayoutVersion = [
    snapshot?.transcript.length ?? 0,
    optimisticUserMessage?.content ?? "",
    optimisticUserMessage?.status ?? "",
    streamingAssistantText,
    loading ? "loading" : "ready",
  ].join(":");

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    const previous = transcriptScrollMetricsRef.current;
    const contextChanged =
      transcriptContextKeyRef.current !== transcriptContextKey;
    const nextScrollHeight = element.scrollHeight;

    if (contextChanged || previous.scrollHeight === 0) {
      // 新项目或新会话默认展示最新消息。这里使用直接定位而非 smooth，
      // 避免历史较长时出现一段可见的自动滚动动画。
      element.scrollTop = nextScrollHeight;
      transcriptPinnedToBottomRef.current = true;
      transcriptContextKeyRef.current = transcriptContextKey;
    } else if (transcriptPinnedToBottomRef.current) {
      // 用户仍在底部时，每一批流式 token 都跟随最新内容。
      element.scrollTop = nextScrollHeight;
    } else {
      // 用户正在阅读上方消息时不强制跳到底部。流式节点增长、乐观消息被
      // 持久化 Transcript 替换等情况会改变内容总高度；补偿高度差可保持
      // 当前阅读锚点相对稳定，避免文本在视口中突然上下跳动。
      const heightDelta = nextScrollHeight - previous.scrollHeight;
      if (heightDelta !== 0) {
        element.scrollTop = Math.max(0, previous.scrollTop + heightDelta);
      }
    }

    transcriptScrollMetricsRef.current = {
      scrollHeight: nextScrollHeight,
      scrollTop: element.scrollTop,
    };
  }, [transcriptContextKey, transcriptLayoutVersion]);

  const handleTranscriptScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element) {
      return;
    }

    const distanceToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    transcriptPinnedToBottomRef.current =
      distanceToBottom <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
    transcriptScrollMetricsRef.current = {
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  }, []);

  async function createConversation() {
    setCreatingConversation(true);
    try {
      const response = await browserApiFetch(
        `/api/projects/${projectId}/agent`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: t("agent.createConversation") }),
        },
      );
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

  function updatePendingAttachment(
    clientId: string,
    update: Partial<PendingAttachment>,
  ) {
    setPendingAttachments((current) =>
      current.map((item) =>
        item.clientId === clientId ? { ...item, ...update } : item,
      ),
    );
  }

  async function uploadAttachment(item: PendingAttachment) {
    updatePendingAttachment(item.clientId, {
      status: "uploading",
      progress: 0,
      error: null,
    });
    try {
      const formData = new FormData();
      formData.append("file", item.file);
      if (selectedConversationId) {
        formData.append("conversationId", selectedConversationId);
      }

      const attachment = await uploadImageFile(
        `/api/projects/${projectId}/attachments`,
        formData,
        (progress) =>
          updatePendingAttachment(item.clientId, {
            progress,
          }),
      );

      updatePendingAttachment(item.clientId, {
        status: "ready",
        progress: 100,
        attachment,
        error: null,
      });
    } catch (error) {
      updatePendingAttachment(item.clientId, {
        status: "failed",
        error:
          error instanceof Error
            ? error.message
            : t("agent.attachmentUploadFailed"),
      });
    }
  }

  function enqueueAttachmentFiles(files: File[]) {
    if (!files.length) {
      return;
    }

    const available = Math.max(0, 4 - pendingAttachmentsRef.current.length);
    const nextFiles = files.slice(0, available);
    const nextItems = nextFiles.map((file) => ({
      clientId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      status: "uploading" as const,
      progress: 0,
      attachment: null,
      error: null,
    }));

    setPendingAttachments((current) => [...current, ...nextItems]);
    for (const item of nextItems) {
      void uploadAttachment(item);
    }
  }

  function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    enqueueAttachmentFiles(files);
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
      .map(
        (file, index) =>
          new File(
            [file],
            file.name ||
              `${t("agent.pastedImageName")}-${Date.now()}-${index + 1}.png`,
            { type: file.type || "image/png" },
          ),
      );

    if (!imageFiles.length) {
      return;
    }

    // 保留剪贴板里的文字粘贴行为，同时把图片加入和文件选择相同的上传队列。
    event.preventDefault();
    enqueueAttachmentFiles(imageFiles);
  }

  async function removePendingAttachment(clientId: string) {
    const item = pendingAttachments.find(
      (candidate) => candidate.clientId === clientId,
    );
    setPendingAttachments((current) => {
      if (item) {
        URL.revokeObjectURL(item.previewUrl);
      }
      return current.filter((candidate) => candidate.clientId !== clientId);
    });

    // 已经写入私有 Blob 的附件不应长期占用存储。删除失败时仍先移除
    // 当前 Composer 项，后端的软删除清理任务可以再次回收这个孤立对象。
    if (item?.attachment) {
      try {
        await browserApiFetch(`/api/attachments/${item.attachment.id}`, {
          method: "DELETE",
        });
      } catch {
        setErrorMessage(t("agent.attachmentDeleteFailed"));
      }
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
    const message =
      draft.trim() ||
      (hasReadyAttachment || hasUploadingAttachment
        ? IMAGE_ONLY_MESSAGE_CONTENT
        : "");

    if (!message || sending || activeRun) {
      return;
    }

    const attachmentIds = pendingAttachments
      .filter(
        (
          attachment,
        ): attachment is PendingAttachment & {
          attachment: AttachmentView;
        } => attachment.status === "ready" && attachment.attachment !== null,
      )
      .map((attachment) => attachment.attachment.id);

    if (hasUploadingAttachment) {
      setErrorMessage(t("agent.waitForAttachmentUpload"));
      return;
    }

    // 用户消息先进入本地投影并立即清空输入框。网络、数据库限流检查和 Run
    // 事务都不再阻塞可见反馈；失败时再把原文恢复到编辑框供用户重试。
    setDraft("");
    setOptimisticUserMessage({
      content: message,
      attachmentIds,
      status: "sending",
    });
    setSending(true);
    setErrorMessage(null);

    try {
      const response = await browserApiFetch("/api/agent-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          conversationId: selectedConversationId ?? undefined,
          message,
          attachmentIds,
          model: selectedModel || undefined,
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
      setPendingAttachments((current) => {
        for (const item of current) {
          URL.revokeObjectURL(item.previewUrl);
        }
        return [];
      });
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
      const response = await browserApiFetch(
        `/api/agent-runs/${activeRun.id}/cancel`,
        {
          method: "POST",
        },
      );
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
    <TooltipProvider>
      <aside className="agent-panel-v2" aria-label={t("agent.aria")}>
        <div className="agent-panel-header">
          <div className="agent-conversation-switcher">
            <button
              aria-expanded={showHistory}
              aria-label={t("agent.conversationHistory")}
              className="agent-conversation-trigger"
              onClick={() => setShowHistory((value) => !value)}
              type="button"
            >
              <Bot size={14} />
              <span>
                {snapshot?.conversation.title ?? t("agent.assistant")}
              </span>
              <ChevronDown className={cn(showHistory && "rotate-180")} />
            </button>
            {showHistory ? (
              <div className="agent-conversation-menu">
                <span className="agent-conversation-menu-label">
                  {conversations.length
                    ? t("agent.conversationCount", {
                        count: conversations.length,
                      })
                    : t("agent.noConversations")}
                </span>
                {conversations.length ? (
                  conversations.map((conversation) => (
                    <button
                      className={cn(
                        "agent-conversation-option",
                        conversation.id === selectedConversationId &&
                          "is-active",
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
          <div className="agent-header-actions">
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent>{t("agent.newConversation")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("agent.refresh")}
                  onClick={() =>
                    void loadAgentSnapshot(selectedConversationId, {
                      showLoading: false,
                    })
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <RefreshCw />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("agent.refresh")}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div
          className="agent-transcript"
          aria-live="polite"
          onScroll={handleTranscriptScroll}
          ref={transcriptRef}
        >
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
            run={latestRun}
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
          {pendingAttachments.length ? (
            <AttachmentTray
              attachments={pendingAttachments}
              onRemove={removePendingAttachment}
              onRetry={(item) => void uploadAttachment(item)}
            />
          ) : null}
          <textarea
            aria-label={t("agent.messageLabel")}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !activeRun) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onPaste={handleComposerPaste}
            placeholder={t("agent.placeholder")}
            ref={draftRef}
            rows={3}
            value={draft}
          />
          <div className="agent-composer-footer">
            <div className="agent-composer-tools">
              <input
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                multiple
                onChange={handleAttachmentSelection}
                ref={attachmentInputRef}
                type="file"
              />
              <Button
                aria-label={t("agent.addAttachment")}
                disabled={
                  Boolean(activeRun) ||
                  sending ||
                  pendingAttachments.length >= 4
                }
                onClick={() => attachmentInputRef.current?.click()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Paperclip />
              </Button>
              <Button
                aria-label={t("agent.openAssets")}
                onClick={() => {
                  setShowAssets(true);
                  void loadAssets();
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ImageIcon />
              </Button>
              {modelOptions.length ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={t("agent.modelSelector")}
                      className="agent-model-trigger"
                      disabled={Boolean(activeRun) || sending}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <span>{selectedModel || modelOptions[0]?.label}</span>
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-44">
                    <DropdownMenuLabel>{t("agent.model")}</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={selectedModel}
                      onValueChange={setSelectedModel}
                    >
                      {modelOptions.map((option) => (
                        <DropdownMenuRadioItem
                          key={option.id}
                          value={option.id}
                        >
                          <span>{option.label}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span>{t("agent.provider", { revision })}</span>
              )}
            </div>
            <Button
              aria-label={activeRun ? t("agent.stopRun") : t("agent.send")}
              className={cn("agent-primary-action", activeRun && "is-stop")}
              disabled={
                activeRun
                  ? stopping
                  : (!draft.trim() && !hasReadyAttachment) || sending
              }
              onClick={
                activeRun
                  ? () => {
                      void stopRun();
                    }
                  : undefined
              }
              size="icon-sm"
              type={activeRun ? "button" : "submit"}
            >
              {activeRun ? (
                stopping ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Square fill="currentColor" />
                )
              ) : sending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Send />
              )}
            </Button>
          </div>
        </form>

        {showAssets ? (
          <AssetPanel
            assets={assets}
            onClose={() => setShowAssets(false)}
            onRefresh={() => void loadAssets()}
          />
        ) : null}

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
    </TooltipProvider>
  );
}

function TranscriptItem({ message }: { message: TranscriptMessage }) {
  const { t } = useUiI18n();

  if (message.kind === "user_message") {
    return (
      <article className="agent-message agent-message-user">
        <span className="agent-message-label">{t("agent.you")}</span>
        {message.attachmentIds?.length ? (
          <AttachmentIdList attachmentIds={message.attachmentIds} />
        ) : null}
        {!isImageOnlyMessageContent(message.content) ? (
          <p>{message.content}</p>
        ) : null}
      </article>
    );
  }

  if (message.kind === "assistant_message") {
    return (
      <article className="agent-message agent-message-assistant">
        <span className="agent-message-label">{t("agent.assistant")}</span>
        <MarkdownRenderer content={message.content} />
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
    const vision = getVisionResultDisplay(message);
    const generated = getGeneratedImageResultDisplay(message);
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
          ) : vision ? (
            <VisionResultSummary summary={vision} />
          ) : generated ? (
            <GeneratedImageResult
              assetIds={generated.assetIds}
              count={generated.assetCount}
            />
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
      {message.attachmentIds?.length ? (
        <AttachmentIdList attachmentIds={message.attachmentIds} />
      ) : null}
      {!isImageOnlyMessageContent(message.content) ? (
        <p>{message.content}</p>
      ) : null}
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
      <MarkdownRenderer content={content} />
    </article>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  return (
    <div className="agent-markdown">
      <ReactMarkdown
        components={{
          a: ({ children, ...props }) => (
            <a {...props} rel="noreferrer noopener" target="_blank">
              {children}
            </a>
          ),
          code: ({ children, className, ...props }) => {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <MarkdownCodeBlock
              copiedCode={copiedCode}
              onCopiedCodeChange={setCopiedCode}
            >
              {children}
            </MarkdownCodeBlock>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownCodeBlock({
  children,
  copiedCode,
  onCopiedCodeChange,
}: ComponentPropsWithoutRef<"pre"> & {
  copiedCode: string | null;
  onCopiedCodeChange: (code: string | null) => void;
}) {
  const { t } = useUiI18n();
  const codeElement = Children.only(children);
  const codeProps = isValidElement<{
    children?: ReactElement | string | string[];
    className?: string;
  }>(codeElement)
    ? codeElement.props
    : {};
  const code = String(codeProps.children ?? "").replace(/\n$/, "");
  const language =
    /language-([\w-]+)/.exec(codeProps.className ?? "")?.[1] ?? t("agent.code");
  const copied = copiedCode === code;

  return (
    <div className="agent-code-block">
      <div className="agent-code-toolbar">
        <span>{language}</span>
        <Button
          aria-label={copied ? t("agent.codeCopied") : t("agent.copyCode")}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              onCopiedCodeChange(code);
              window.setTimeout(() => {
                onCopiedCodeChange(null);
              }, 1500);
            });
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <pre>
        <code className={codeProps.className}>{code}</code>
      </pre>
    </div>
  );
}

function AgentRunStatus({
  run,
  activeTool,
  hasStreamingAssistantText,
  onReviewChanges,
  verificationRuns,
  verificationSteps,
}: {
  run: AgentRunRecord;
  activeTool: ToolInvocationRecord | null;
  hasStreamingAssistantText: boolean;
  onReviewChanges: () => void;
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
      ? run.budget.maxModelTurns === null
        ? run.usage.modelTurns + 1
        : Math.min(run.usage.modelTurns + 1, run.budget.maxModelTurns)
      : run.usage.modelTurns;
  const modelTurnLimit = run.budget.maxModelTurns ?? "∞";
  const activeDetail = activeTool
    ? t("agent.executingTool", { tool: activeTool.toolName })
    : run.status === "running" && hasStreamingAssistantText
      ? t("agent.modelResponding")
      : status.detail;

  return (
    <details
      className={cn(
        "agent-run-status",
        isActive && "is-active",
        `is-${status.tone}`,
      )}
    >
      <summary aria-label={t("agent.toggleRunDetails")}>
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
        <span className="agent-run-status-summary-detail">{activeDetail}</span>
        <span className="agent-run-status-summary-end">
          {elapsed}
          <ChevronDown />
        </span>
      </summary>
      <div className="agent-run-status-content">
        <div className="agent-run-status-detail">
          <span>{activeDetail}</span>
          <span>
            {displayedModelTurns}/{modelTurnLimit} {t("agent.turns")} · r
            {run.currentRevision}
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
            {run.usage.latestVerificationOk ? (
              <ShieldCheck />
            ) : (
              <TriangleAlert />
            )}
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
        {!isActive ? <p className="agent-run-error">{status.message}</p> : null}
        {run.status === "succeeded" ? (
          <Button onClick={onReviewChanges} size="sm" variant="outline">
            <GitCompareArrows data-icon="inline-start" />
            {t("agent.reviewChanges")}
          </Button>
        ) : null}
      </div>
    </details>
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
    <details className="agent-verification-history">
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
      if (run.errorCode === AGENT_ERROR_CODES.noProgress) {
        return {
          title: t("agent.statusNoProgress"),
          detail: t("agent.statusNoProgressDetail"),
          message: t("agent.statusNoProgressMessage"),
          tone: "warning",
        };
      }
      if (run.errorCode === AGENT_ERROR_CODES.fileMutationsExhausted) {
        return {
          title: t("agent.statusFileMutationsBudget"),
          detail: t("agent.statusFileMutationsBudgetDetail", {
            used: run.usage.fileMutations,
            limit: run.budget.maxFileMutations,
          }),
          message: t("agent.statusFileMutationsBudgetMessage"),
          tone: "warning",
        };
      }
      if (run.errorCode === AGENT_ERROR_CODES.clientResumesExhausted) {
        return {
          title: t("agent.statusClientResumesBudget"),
          detail: t("agent.statusClientResumesBudgetDetail", {
            used: run.usage.clientResumes,
            limit: run.budget.maxClientResumes,
          }),
          message: t("agent.statusClientResumesBudgetMessage"),
          tone: "warning",
        };
      }
      if (run.errorCode === AGENT_ERROR_CODES.wallTimeExhausted) {
        return {
          title: t("agent.statusWallTimeBudget"),
          detail: t("agent.statusWallTimeBudgetDetail", {
            used: Math.ceil(run.usage.activeExecutionDurationMs / 1_000),
            limit: run.budget.maxWallTimeSeconds,
          }),
          message: t("agent.statusWallTimeBudgetMessage"),
          tone: "warning",
        };
      }
      if (run.errorCode === AGENT_ERROR_CODES.outputExhausted) {
        return {
          title: t("agent.statusOutputBudget"),
          detail: t("agent.statusOutputBudgetDetail", {
            limit: run.budget.maxOutputCharacters,
          }),
          message: t("agent.statusOutputBudgetMessage"),
          tone: "warning",
        };
      }
      if (
        run.errorCode === AGENT_ERROR_CODES.modelTurnsExhausted ||
        run.errorCode === AGENT_ERROR_CODES.budgetExhausted
      ) {
        return {
          title: t("agent.statusModelTurnsBudget"),
          detail: t("agent.statusModelTurnsBudgetDetail", {
            used: run.usage.modelTurns,
            limit: run.budget.maxModelTurns ?? "∞",
          }),
          message: t("agent.statusModelTurnsBudgetMessage"),
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

type VisionResultDisplay = {
  description: string;
  objects: string[];
  text: string[];
  colors: string[];
  layout: string;
  confidence: number;
};

function getVisionResultDisplay(
  message: Extract<TranscriptMessage, { kind: "tool_result" }>,
): VisionResultDisplay | null {
  if (
    message.toolName !== "inspect_attachment" ||
    message.resultJson.ok !== true
  ) {
    return null;
  }

  const data = asRecord(message.resultJson.data);
  const summary = asRecord(data.summary);
  if (
    typeof summary.description !== "string" ||
    !Array.isArray(summary.objects) ||
    !Array.isArray(summary.text) ||
    !Array.isArray(summary.colors) ||
    typeof summary.layout !== "string" ||
    typeof summary.confidence !== "number"
  ) {
    return null;
  }

  return {
    description: summary.description,
    objects: summary.objects.filter(
      (item): item is string => typeof item === "string",
    ),
    text: summary.text.filter(
      (item): item is string => typeof item === "string",
    ),
    colors: summary.colors.filter(
      (item): item is string => typeof item === "string",
    ),
    layout: summary.layout,
    confidence: summary.confidence,
  };
}

function getGeneratedImageResultDisplay(
  message: Extract<TranscriptMessage, { kind: "tool_result" }>,
): { assetCount: number; assetIds: string[] } | null {
  if (message.toolName !== "generate_image" || message.resultJson.ok !== true) {
    return null;
  }

  const data = asRecord(message.resultJson.data);
  const assetCount = typeof data.assetCount === "number" ? data.assetCount : 0;
  const assetIds = Array.isArray(data.assetIds)
    ? data.assetIds.filter(
        (assetId): assetId is string => typeof assetId === "string",
      )
    : [];

  return assetCount > 0 || assetIds.length > 0
    ? { assetCount, assetIds }
    : null;
}

function AttachmentIdList({ attachmentIds }: { attachmentIds: string[] }) {
  const { t } = useUiI18n();

  return (
    <div
      className="agent-attachment-id-list"
      aria-label={t("agent.attachments")}
    >
      {attachmentIds.map((attachmentId, index) => (
        <a
          className="agent-attachment-id"
          href={`/api/attachments/${attachmentId}`}
          key={attachmentId}
          rel="noreferrer"
          target="_blank"
        >
          <img
            alt={t("agent.attachmentPreview", { index: index + 1 })}
            loading="lazy"
            src={`/api/attachments/${attachmentId}`}
          />
          <span>{t("agent.attachmentNumber", { number: index + 1 })}</span>
        </a>
      ))}
    </div>
  );
}

function VisionResultSummary({ summary }: { summary: VisionResultDisplay }) {
  const { t } = useUiI18n();
  const fields = [
    [t("agent.visionObjects"), summary.objects],
    [t("agent.visionText"), summary.text],
    [t("agent.visionColors"), summary.colors],
  ] as const;

  return (
    <div className="agent-vision-result">
      <p>{summary.description}</p>
      <div className="agent-vision-facts">
        <span>
          {t("agent.visionConfidence", {
            confidence: Math.round(summary.confidence * 100),
          })}
        </span>
        <span>{summary.layout}</span>
      </div>
      {fields.map(([label, values]) =>
        values.length ? (
          <div className="agent-vision-fact" key={label}>
            <small>{label}</small>
            <div>
              {values.slice(0, 8).map((value) => (
                <span key={value}>{value}</span>
              ))}
            </div>
          </div>
        ) : null,
      )}
    </div>
  );
}

function GeneratedImageResult({
  assetIds,
  count,
}: {
  assetIds: string[];
  count: number;
}) {
  const { t } = useUiI18n();

  return (
    <div className="agent-generated-result">
      <span>{t("agent.generatedImages", { count })}</span>
      {assetIds.length ? (
        <div className="agent-generated-thumbnails">
          {assetIds.slice(0, 4).map((assetId, index) => (
            <a
              href={`/api/project-assets/${assetId}`}
              key={assetId}
              rel="noreferrer"
              target="_blank"
            >
              <img
                alt={t("agent.generatedImageNumber", { number: index + 1 })}
                loading="lazy"
                src={`/api/project-assets/${assetId}`}
              />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentTray({
  attachments,
  onRemove,
  onRetry,
}: {
  attachments: PendingAttachment[];
  onRemove: (clientId: string) => void | Promise<void>;
  onRetry: (item: PendingAttachment) => void;
}) {
  const { t } = useUiI18n();

  return (
    <div className="agent-attachment-tray" aria-label={t("agent.attachments")}>
      {attachments.map((item) => (
        <article className="agent-attachment-card" key={item.clientId}>
          <img alt={item.file.name} src={item.previewUrl} />
          <div className="agent-attachment-card-body">
            <strong title={item.file.name}>{item.file.name}</strong>
            {item.status === "uploading" ? (
              <div className="agent-attachment-progress">
                <span style={{ width: `${item.progress}%` }} />
                <small>{item.progress}%</small>
              </div>
            ) : item.status === "failed" ? (
              <div className="agent-attachment-failed">
                <small>{item.error ?? t("agent.attachmentUploadFailed")}</small>
                <Button
                  aria-label={t("agent.retryAttachment")}
                  onClick={() => onRetry(item)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCw />
                </Button>
              </div>
            ) : (
              <small>{t("agent.attachmentReady")}</small>
            )}
          </div>
          <Button
            aria-label={t("agent.removeAttachment", { name: item.file.name })}
            onClick={() => void onRemove(item.clientId)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </article>
      ))}
    </div>
  );
}

function AssetPanel({
  assets,
  onClose,
  onRefresh,
}: {
  assets: AssetView[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { t } = useUiI18n();

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="agent-assets-dialog">
        <DialogHeader>
          <DialogTitle>{t("agent.assetsTitle")}</DialogTitle>
          <DialogDescription>{t("agent.assetsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="agent-assets-toolbar">
          <span>{t("agent.assetCount", { count: assets.length })}</span>
          <Button onClick={onRefresh} size="sm" variant="outline">
            <RefreshCw data-icon="inline-start" />
            {t("agent.refreshAssets")}
          </Button>
        </div>
        {assets.length ? (
          <div className="agent-assets-grid">
            {assets.map((asset) => (
              <a
                className="agent-asset-card"
                href={`/api/project-assets/${asset.id}`}
                key={asset.id}
                rel="noreferrer"
                target="_blank"
              >
                <img
                  alt={asset.originalFilename ?? t("agent.generatedAsset")}
                  loading="lazy"
                  src={`/api/project-assets/${asset.id}`}
                />
                <span>
                  <strong>
                    {asset.originalFilename ?? t("agent.generatedAsset")}
                  </strong>
                  <small>
                    {asset.kind === "uploaded_image"
                      ? t("agent.uploadedAsset")
                      : t("agent.generatedAsset")}
                  </small>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div className="agent-assets-empty">
            <ImageIcon />
            <span>{t("agent.assetsEmpty")}</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function uploadImageFile(
  url: string,
  formData: FormData,
  onProgress: (progress: number) => void,
): Promise<AttachmentView> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      const body = request.response as {
        attachments?: AttachmentView[];
        error?: { message?: string };
      } | null;
      if (
        request.status < 200 ||
        request.status >= 300 ||
        !body?.attachments?.[0]
      ) {
        reject(new Error(body?.error?.message ?? "图片上传失败。"));
        return;
      }
      resolve(body.attachments[0]);
    });
    request.addEventListener("error", () =>
      reject(new Error("图片上传失败。")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("图片上传已取消。")),
    );
    request.send(formData);
  });
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
    case "IMAGE_VISION_TIMEOUT":
      return {
        title: t("agent.statusVisionTimeout"),
        detail: t("agent.statusVisionTimeoutDetail"),
        message: t("agent.statusVisionTimeoutMessage"),
        tone: "error",
      };
    case "IMAGE_VISION_CONTENT_REJECTED":
      return {
        title: t("agent.statusVisionRejected"),
        detail: t("agent.statusVisionRejectedDetail"),
        message: t("agent.statusVisionRejectedMessage"),
        tone: "error",
      };
    case "IMAGE_VISION_INVALID_RESPONSE":
      return {
        title: t("agent.statusVisionInvalidResponse"),
        detail: t("agent.statusVisionInvalidResponseDetail"),
        message: t("agent.statusVisionInvalidResponseMessage"),
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
  const response = await browserApiFetch(
    `/api/projects/${projectId}/agent${query}`,
    {
      cache: "no-store",
    },
  );
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

function createAgentSnapshotCacheKey(
  projectId: string,
  conversationId: string,
): string {
  return `${projectId}:${conversationId}`;
}

function readAgentSnapshotCache(
  projectId: string,
  conversationId = LATEST_CONVERSATION_CACHE_KEY,
): AgentResponse | null {
  const key = createAgentSnapshotCacheKey(projectId, conversationId);
  const cached = agentSnapshotCache.get(key);
  if (!cached) {
    return null;
  }

  // Map 的插入顺序同时承担轻量 LRU。命中时重新插入，频繁访问的项目不会
  // 因为用户打开多个其他项目而过早被淘汰。
  agentSnapshotCache.delete(key);
  agentSnapshotCache.set(key, cached);
  return cached;
}

function writeAgentSnapshotCache(
  projectId: string,
  response: AgentResponse,
): void {
  const keys = [LATEST_CONVERSATION_CACHE_KEY];
  if (response.snapshot?.conversation.id) {
    keys.push(response.snapshot.conversation.id);
  }

  for (const conversationId of keys) {
    const key = createAgentSnapshotCacheKey(projectId, conversationId);
    agentSnapshotCache.delete(key);
    agentSnapshotCache.set(key, response);
  }

  while (agentSnapshotCache.size > MAX_AGENT_SNAPSHOT_CACHE_ENTRIES) {
    const oldestKey = agentSnapshotCache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    agentSnapshotCache.delete(oldestKey);
  }
}

function getLatestAgentEventSequence(
  snapshot: AgentConversationSnapshot | null | undefined,
): number {
  return (
    snapshot?.events.reduce(
      (cursor, event) => Math.max(cursor, event.sequence),
      0,
    ) ?? 0
  );
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

function parsePersistedEvent(value: string): AgentRunEvent | null {
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      runId?: unknown;
      sequence?: unknown;
      type?: unknown;
      payload?: unknown;
      createdAt?: unknown;
    };

    if (
      typeof parsed.id !== "string" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.sequence !== "number" ||
      !Number.isInteger(parsed.sequence) ||
      parsed.sequence < 0 ||
      typeof parsed.type !== "string" ||
      !parsed.payload ||
      typeof parsed.payload !== "object" ||
      Array.isArray(parsed.payload) ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }

    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }

    return {
      id: parsed.id,
      runId: parsed.runId,
      sequence: parsed.sequence,
      type: parsed.type,
      payload: parsed.payload as Record<string, unknown>,
      createdAt,
    };
  } catch {
    return null;
  }
}
