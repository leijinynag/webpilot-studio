import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentPanel,
  clearAgentSnapshotCache,
} from "@/components/workbench/agent-panel";
import { IMAGE_ONLY_MESSAGE_CONTENT } from "@/domains/agent/message-content";
import {
  EMPTY_AGENT_RUN_USAGE,
  type AgentConversationSnapshot,
  type AgentRunRecord,
  type ConversationRecord,
  type TranscriptMessage,
} from "@/domains/agent/types";

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, EventListener[]>();
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string | URL) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {}

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emit(type: string, data: Record<string, unknown>, lastEventId: string) {
    const event = new MessageEvent("message", {
      data: JSON.stringify(data),
      lastEventId,
    });

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const conversation: ConversationRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  ownerId: "owner-1",
  title: "恢复终态",
  contextCheckpoint: {
    summary: null,
    transcriptSeq: 0,
    version: 0,
    updatedAt: null,
  },
  createdAt: new Date("2026-07-30T00:00:00.000Z"),
  updatedAt: new Date("2026-07-30T00:01:00.000Z"),
};

function createRun(status: AgentRunRecord["status"]): AgentRunRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    conversationId: conversation.id,
    projectId: conversation.projectId,
    ownerId: conversation.ownerId,
    status,
    startRevision: 1,
    currentRevision: 2,
    locale: "zh-CN",
    provider: "deepseek",
    model: "deepseek-chat",
    promptProfile: "default",
    promptDigest: "prompt",
    toolsetProfile: "default",
    toolsetDigest: "toolset",
    modelProfile: "default",
    repositoryCapability: {
      storageKind: "database",
      canRead: true,
      canWrite: true,
      canExecuteServerTools: true,
    },
    budget: {
      maxModelTurns: 12,
      maxWallTimeSeconds: 300,
      maxOutputCharacters: 24_000,
      maxToolResultCharacters: 20_000,
      maxFileMutations: 8,
      maxClientResumes: 6,
      maxNoProgressRepeats: 2,
    },
    usage: {
      ...EMPTY_AGENT_RUN_USAGE,
      modelTurns: 4,
      fileMutations: 1,
      latestVerificationRevision: 2,
      latestVerificationOk: true,
    },
    correlationId: "44444444-4444-4444-8444-444444444444",
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    cancellationRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-07-30T00:00:00.000Z"),
    startedAt: new Date("2026-07-30T00:00:01.000Z"),
    completedAt:
      status === "succeeded" ? new Date("2026-07-30T00:01:00.000Z") : null,
    updatedAt: new Date("2026-07-30T00:01:00.000Z"),
  };
}

function createSnapshot(
  status: AgentRunRecord["status"],
): AgentConversationSnapshot {
  const run = createRun(status);
  return {
    conversation,
    transcript: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        conversationId: conversation.id,
        runId: run.id,
        seq: 1,
        role: "user",
        kind: "user_message",
        content: "修改页面标题",
      },
    ],
    runs: [run],
    events: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        runId: run.id,
        sequence: 12,
        type: "run.status_changed",
        payload: { status: "succeeded" },
        createdAt: new Date("2026-07-30T00:01:00.000Z"),
      },
    ],
    tools: [],
    verificationRuns: [],
    verificationSteps: [],
  };
}

function createEmptySnapshot(): AgentConversationSnapshot {
  return {
    conversation,
    transcript: [],
    runs: [],
    events: [],
    tools: [],
    verificationRuns: [],
    verificationSteps: [],
  };
}

function installModelAwareFetchMock(
  fallbackFetch: ReturnType<typeof vi.fn<typeof fetch>>,
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = String(input);
    if (url.includes("/api/agent-models")) {
      return Promise.resolve(
        Response.json({
          models: [
            {
              id: "deepseek-v4-pro",
              label: "deepseek-v4-pro",
              tier: "agent",
            },
            {
              id: "deepseek-v4-flash",
              label: "deepseek-v4-flash",
              tier: "fast",
            },
            {
              id: "gpt-5.5",
              label: "gpt-5.5",
              tier: "agent",
            },
          ],
        }),
      );
    }

    // 模型列表请求是 AgentPanel 的独立辅助请求。其余请求继续交给每个
    // 测试自己配置的响应队列，避免新增能力改变原有快照测试的时序。
    return fallbackFetch(input, init);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AgentPanel", () => {
  afterEach(() => {
    cleanup();
    clearAgentSnapshotCache();
    vi.unstubAllGlobals();
    MockEventSource.instances = [];
  });

  it("在终态 SSE 被游标越过后重新拉取快照并恢复完成态", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // 首次加载模拟刷新竞态：Run 仍是 running，但事件游标已包含终态事件。
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("running"),
        }),
      )
      // SSE 因服务端检测到终态而关闭后，数据库快照已经收敛为 succeeded。
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("succeeded"),
        }),
      );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    expect(await screen.findByText("执行中", { exact: true })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "停止 Agent Run" }),
    ).toBeVisible();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(String(MockEventSource.instances[0]?.url)).toContain("?cursor=12");

    await act(async () => {
      MockEventSource.instances[0]?.emitError();
    });

    expect(await screen.findByText("已完成", { exact: true })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "停止 Agent Run" }),
    ).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByLabelText("展开或收起运行详情"));
    expect(screen.getByRole("button", { name: "查看改动" })).toBeVisible();
    expect(screen.getByLabelText("给 Agent 的消息")).toBeEnabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("模型空 Tool Call 重试时立即清空已丢弃的流式前言", async () => {
    const runningSnapshot = createSnapshot("running");
    runningSnapshot.events = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    await screen.findByText("执行中", { exact: true });
    const stream = MockEventSource.instances[0];
    expect(stream).toBeDefined();

    await act(async () => {
      stream?.emit(
        "assistant.delta",
        {
          id: "event-delta",
          runId: createRun("running").id,
          sequence: 1,
          type: "assistant.delta",
          payload: { text: "我先检查项目结构。" },
          createdAt: new Date().toISOString(),
        },
        "1",
      );
    });
    await waitFor(() => {
      expect(screen.getByText("我先检查项目结构。")).toBeVisible();
    });

    await act(async () => {
      stream?.emit(
        "model.turn_retried",
        {
          id: "event-retry",
          runId: createRun("running").id,
          sequence: 2,
          type: "model.turn_retried",
          payload: {
            reason: "empty_tool_calls",
            discardedCharacterCount: 9,
            consumedModelTurns: 1,
          },
          createdAt: new Date().toISOString(),
        },
        "2",
      );
    });

    expect(screen.queryByText("我先检查项目结构。")).not.toBeInTheDocument();
  });

  it("首轮执行时显示当前模型轮次并区分已经开始流式响应", async () => {
    const runningSnapshot = createSnapshot("running");
    runningSnapshot.runs[0] = {
      ...runningSnapshot.runs[0]!,
      currentRevision: 0,
      usage: { ...EMPTY_AGENT_RUN_USAGE },
    };
    runningSnapshot.events = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    const runDetails = await screen.findByLabelText("展开或收起运行详情");
    expect(
      runDetails
        .closest("details")
        ?.querySelector(".agent-run-status-summary-detail"),
    ).toHaveTextContent("正在请求模型规划下一步");
    await userEvent.setup().click(runDetails);
    expect(screen.getByText(/1\/12 轮次/)).toBeVisible();

    await act(async () => {
      MockEventSource.instances[0]?.emit(
        "assistant.delta",
        {
          id: "event-first-delta",
          runId: createRun("running").id,
          sequence: 1,
          type: "assistant.delta",
          payload: { text: "正在读取项目。" },
          createdAt: new Date().toISOString(),
        },
        "1",
      );
    });

    await waitFor(() => {
      expect(
        runDetails
          .closest("details")
          ?.querySelector(".agent-run-status-summary-detail"),
      ).toHaveTextContent("模型已响应，正在完成当前步骤");
    });
  });

  it("文件写入预算耗尽时不再误报为模型轮次上限", async () => {
    const exhaustedSnapshot = createSnapshot("budget_exhausted");
    exhaustedSnapshot.runs[0] = {
      ...exhaustedSnapshot.runs[0]!,
      errorCode: "AGENT_FILE_MUTATIONS_EXHAUSTED",
      errorMessage: "Agent 已达到文件 mutation 次数上限。",
      budget: {
        ...exhaustedSnapshot.runs[0]!.budget,
        maxModelTurns: 32,
        maxFileMutations: 8,
      },
      usage: {
        ...exhaustedSnapshot.runs[0]!.usage,
        modelTurns: 9,
        fileMutations: 8,
      },
      completedAt: new Date("2026-07-30T00:01:00.000Z"),
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: exhaustedSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    expect(
      await screen.findByText("文件写入预算已用尽", { exact: true }),
    ).toBeVisible();
    const runDetails = screen.getByLabelText("展开或收起运行详情");
    expect(
      runDetails
        .closest("details")
        ?.querySelector(".agent-run-status-summary-detail"),
    ).toHaveTextContent("已完成 8/8 次源码写入");
    await userEvent.setup().click(runDetails);
    expect(screen.getByText(/9\/32 轮次/)).toBeVisible();
    expect(screen.queryByText("模型轮次预算已用尽")).not.toBeInTheDocument();
  });

  it("合并密集 SSE 事件，只在短窗口内读取一次完整快照", async () => {
    const runningSnapshot = createSnapshot("running");
    runningSnapshot.events = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    await screen.findByText("执行中", { exact: true });
    const stream = MockEventSource.instances[0];

    await act(async () => {
      for (let sequence = 1; sequence <= 8; sequence += 1) {
        stream?.emit(
          "assistant.delta",
          {
            id: `event-delta-${sequence}`,
            runId: createRun("running").id,
            sequence,
            type: "assistant.delta",
            payload: { text: String(sequence) },
            createdAt: new Date().toISOString(),
          },
          String(sequence),
        );
      }
    });

    await waitFor(() => {
      expect(screen.getByText("12345678")).toBeVisible();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 1_000 },
    );
  });

  it("从 SSE 转发完整文件流事件，且高频增量不触发聚合快照", async () => {
    const runningSnapshot = createSnapshot("running");
    runningSnapshot.events = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);
    const onFileStreamEvents = vi.fn();

    render(
      <AgentPanel
        dirtyPaths={[]}
        onFileStreamEvents={onFileStreamEvents}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    await screen.findByText("执行中", { exact: true });
    const stream = MockEventSource.instances[0];
    expect(stream).toBeDefined();
    for (const eventType of [
      "file.stream_started",
      "file.stream_delta",
      "file.stream_completed",
      "file.stream_discarded",
    ]) {
      expect(stream?.listeners.has(eventType)).toBe(true);
    }

    await act(async () => {
      stream?.emit(
        "file.stream_delta",
        {
          id: "event-file-delta",
          runId: createRun("running").id,
          sequence: 3,
          type: "file.stream_delta",
          payload: {
            toolCallId: "tool-write-1",
            path: "src/app.tsx",
            text: "export default",
          },
          createdAt: "2026-08-15T01:00:00.000Z",
        },
        "3",
      );
    });

    expect(onFileStreamEvents).toHaveBeenLastCalledWith(conversation.id, [
      expect.objectContaining({
        id: "event-file-delta",
        runId: createRun("running").id,
        sequence: 3,
        type: "file.stream_delta",
        payload: expect.objectContaining({
          toolCallId: "tool-write-1",
          text: "export default",
        }),
        createdAt: new Date("2026-08-15T01:00:00.000Z"),
      }),
    ]);

    // 等过普通事件的 160ms 合并窗口，文件流事件仍不应额外读取完整快照。
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("从快照恢复文件流事件，并让正式工具完成事件继续触发收敛刷新", async () => {
    const runningSnapshot = createSnapshot("running");
    const runId = runningSnapshot.runs[0]!.id;
    runningSnapshot.events = [
      {
        id: "event-stream-start",
        runId,
        sequence: 1,
        type: "file.stream_started",
        payload: {
          toolCallId: "tool-write-1",
          path: "src/app.tsx",
        },
        createdAt: new Date("2026-08-15T01:00:00.000Z"),
      },
    ];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);
    const onFileStreamEvents = vi.fn();

    render(
      <AgentPanel
        dirtyPaths={[]}
        onFileStreamEvents={onFileStreamEvents}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    await waitFor(() => {
      expect(onFileStreamEvents).toHaveBeenCalledWith(
        conversation.id,
        expect.arrayContaining([
          expect.objectContaining({
            id: "event-stream-start",
            type: "file.stream_started",
          }),
        ]),
      );
    });

    const stream = MockEventSource.instances[0];
    await act(async () => {
      stream?.emit(
        "tool.completed",
        {
          id: "event-tool-completed",
          runId,
          sequence: 2,
          type: "tool.completed",
          payload: {
            toolCallId: "tool-write-1",
            toolName: "write_file",
            ok: true,
            revision: 3,
          },
          createdAt: "2026-08-15T01:00:01.000Z",
        },
        "2",
      );
    });

    expect(onFileStreamEvents).toHaveBeenLastCalledWith(conversation.id, [
      expect.objectContaining({
        id: "event-tool-completed",
        type: "tool.completed",
        sequence: 2,
      }),
    ]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("项目切换后忽略迟到的旧首屏快照", async () => {
    let resolveOldRequest: ((response: Response) => void) | undefined;
    const oldRequest = new Promise<Response>((resolve) => {
      resolveOldRequest = resolve;
    });
    const nextConversation = {
      ...conversation,
      id: "77777777-7777-4777-8777-777777777777",
      projectId: "88888888-8888-4888-8888-888888888888",
      title: "新项目会话",
    };
    const nextSnapshot = {
      ...createSnapshot("succeeded"),
      conversation: nextConversation,
      runs: [
        {
          ...createRun("succeeded"),
          conversationId: nextConversation.id,
          projectId: nextConversation.projectId,
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(
        Response.json({
          conversations: [nextConversation],
          snapshot: nextSnapshot,
        }),
      );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    const view = render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    // 先确认旧项目请求已经在途，再切换 projectId；这样测试覆盖的是迟到响应，
    // 而不是 React 尚未执行首个 effect 时发生的同步 rerender。
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={nextConversation.projectId}
        revision={2}
      />,
    );

    expect(await screen.findByText("新项目会话")).toBeVisible();

    await act(async () => {
      resolveOldRequest?.(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("running"),
        }),
      );
    });

    expect(screen.getByText("新项目会话")).toBeVisible();
    expect(screen.queryByText("恢复终态")).not.toBeInTheDocument();
    expect(screen.getByText("已完成", { exact: true })).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("显式选择历史会话后不被迟到的首屏默认加载覆盖", async () => {
    const user = userEvent.setup();
    const activeConversation = {
      ...conversation,
      id: "99999999-9999-4999-8999-999999999999",
      title: "正在生成页面",
    };
    const activeSnapshot = {
      ...createSnapshot("awaiting_client_tool"),
      conversation: activeConversation,
      runs: [
        {
          ...createRun("awaiting_client_tool"),
          conversationId: activeConversation.id,
          currentRevision: 5,
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation, activeConversation],
          snapshot: createEmptySnapshot(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation, activeConversation],
          snapshot: activeSnapshot,
        }),
      );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);
    const onRevisionChange = vi.fn();

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRevisionChange={onRevisionChange}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    expect(await screen.findByText("恢复终态")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "查看会话历史" }));
    await user.click(screen.getByRole("button", { name: "正在生成页面" }));

    expect(await screen.findByText("正在生成页面")).toBeVisible();
    expect(fetchMock.mock.calls[1]?.[0]).toContain(
      `conversationId=${activeConversation.id}`,
    );
    expect(screen.queryByText("恢复终态")).not.toBeInTheDocument();
    expect(onRevisionChange).toHaveBeenCalledWith(5);
  });

  it("POST 尚未返回时立即显示用户消息并清空输入框", async () => {
    const user = userEvent.setup();
    let resolveCreateRun: ((response: Response) => void) | undefined;
    const createRunResponse = new Promise<Response>((resolve) => {
      resolveCreateRun = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createEmptySnapshot(),
        }),
      )
      .mockReturnValueOnce(createRunResponse)
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("running"),
        }),
      );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    const composer = await screen.findByLabelText("给 Agent 的消息");
    await user.type(composer, "从空项目创建一个计数器");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(screen.getByTestId("optimistic-user-message")).toHaveTextContent(
      "从空项目创建一个计数器",
    );
    expect(screen.getByText("你 · 发送中")).toBeVisible();
    expect(composer).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveCreateRun?.(
        Response.json(
          { run: createRun("running") },
          {
            status: 201,
          },
        ),
      );
    });

    expect(await screen.findByText("你 · 已排队")).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it("创建 Run 失败时撤回乐观消息并恢复原输入", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createEmptySnapshot(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "当前网络不可用。" } },
          { status: 503 },
        ),
      );
    installModelAwareFetchMock(fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    const composer = await screen.findByLabelText("给 Agent 的消息");
    await user.type(composer, "保留这条消息");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前网络不可用。",
    );
    expect(composer).toHaveValue("保留这条消息");
    expect(
      screen.queryByTestId("optimistic-user-message"),
    ).not.toBeInTheDocument();
  });

  it("选择模型后把模型冻结值提交给 Run API", async () => {
    const user = userEvent.setup();
    const fetchQueue = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createEmptySnapshot(),
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { run: createRun("running") },
          {
            status: 201,
          },
        ),
      )
      .mockResolvedValue(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("running"),
        }),
      );
    const fetchMock = installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    const composer = await screen.findByLabelText("给 Agent 的消息");
    await user.click(screen.getByRole("button", { name: "选择 Agent 模型" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "deepseek-v4-flash" }),
    );
    await user.type(composer, "使用快速模型生成页面");
    await user.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => {
      expect(fetchQueue).toHaveBeenCalledWith(
        "/api/agent-runs",
        expect.objectContaining({
          body: expect.stringContaining('"model":"deepseek-v4-flash"'),
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/agent-models", {
      cache: "no-store",
    });
  });

  it("渲染已持久化图片消息时隐藏图片-only占位符并显示可预览缩略图", async () => {
    const imageSnapshot = createSnapshot("succeeded");
    imageSnapshot.transcript = [
      {
        ...(imageSnapshot.transcript[0] as Extract<
          TranscriptMessage,
          { kind: "user_message" }
        >),
        content: IMAGE_ONLY_MESSAGE_CONTENT,
        attachmentIds: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
        ],
      },
    ];
    const fetchQueue = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: imageSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    expect(await screen.findByLabelText("图片附件")).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(
      screen.queryByText(IMAGE_ONLY_MESSAGE_CONTENT),
    ).not.toBeInTheDocument();
    expect(screen.getByAltText("第 1 张图片预览")).toHaveAttribute(
      "src",
      "/api/attachments/00000000-0000-4000-8000-000000000001",
    );
  });

  it("返回工作台时立即恢复标签页缓存并在后台重验证", async () => {
    let resolveRevalidation: ((response: Response) => void) | undefined;
    const revalidation = new Promise<Response>((resolve) => {
      resolveRevalidation = resolve;
    });
    const fetchQueue = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("succeeded"),
        }),
      )
      .mockReturnValueOnce(revalidation);
    installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    const firstView = render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );
    expect(await screen.findByText("修改页面标题")).toBeVisible();
    firstView.unmount();

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    // 第二次挂载的 GET 仍在等待，但成功快照应立即可见，不能重新覆盖成恢复占位。
    expect(screen.getByText("修改页面标题")).toBeVisible();
    expect(
      screen.queryByText("正在恢复 Agent 会话..."),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchQueue).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveRevalidation?.(
        Response.json({
          conversations: [conversation],
          snapshot: createSnapshot("succeeded"),
        }),
      );
    });
  });

  it("运行中保持输入可编辑，Enter 不会误触发停止或提交", async () => {
    const user = userEvent.setup();
    const runningSnapshot = createSnapshot("running");
    runningSnapshot.events = [];
    const fetchQueue = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    const composer = await screen.findByLabelText("给 Agent 的消息");
    const stopButton = await screen.findByRole("button", {
      name: "停止 Agent Run",
    });
    const runDetails = screen.getByLabelText("展开或收起运行详情");

    expect(composer).toBeEnabled();
    expect(stopButton).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "停止 Agent Run" }),
    ).toHaveLength(1);
    expect(runDetails.closest("details")).not.toHaveAttribute("open");

    await user.type(composer, "下一轮继续优化");
    await user.keyboard("{Enter}");

    expect(composer).toHaveValue("下一轮继续优化\n");
    expect(fetchQueue).toHaveBeenCalledTimes(1);
    expect(stopButton).toBeVisible();
  });

  it("运行详情与失败的 Browser Verify 默认折叠，按需展开查看", async () => {
    const user = userEvent.setup();
    const snapshot = createSnapshot("succeeded");
    snapshot.verificationRuns = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        seq: 1,
        runId: snapshot.runs[0]!.id,
        toolCallId: "verify-call-1",
        projectId: conversation.projectId,
        ownerId: conversation.ownerId,
        revision: 2,
        status: "failed",
        source: "agent",
        replayCount: 0,
        smokeSteps: [],
        acceptedNetworkFailures: [],
        buildEvidence: null,
        runtimeEvidence: null,
        consoleEvidence: null,
        browserEvidence: null,
        networkEvidence: null,
        buildOk: true,
        runtimeOk: true,
        consoleOk: false,
        networkOk: true,
        actionsOk: true,
        assertionsOk: false,
        revisionOk: true,
        failedStep: 0,
        summary: "按钮仍不可见",
        startedAt: new Date("2026-07-30T00:00:10.000Z"),
        completedAt: new Date("2026-07-30T00:00:12.000Z"),
        createdAt: new Date("2026-07-30T00:00:10.000Z"),
      },
    ];
    const fetchQueue = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot,
      }),
    );
    installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    const runDetails = await screen.findByLabelText("展开或收起运行详情");
    expect(runDetails.closest("details")).not.toHaveAttribute("open");

    await user.click(runDetails);
    const verificationSummary = screen.getByText("Browser Verify");
    const verificationDetails = verificationSummary.closest("details");
    expect(verificationDetails).not.toHaveAttribute("open");

    await user.click(verificationSummary);
    expect(verificationDetails).toHaveAttribute("open");
    expect(screen.getByText(/按钮仍不可见/)).toBeVisible();
  });

  it("使用 GFM 渲染持久化回复并支持复制 fenced code", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue();
    const markdownSnapshot = createSnapshot("succeeded");
    markdownSnapshot.transcript.push({
      id: "88888888-8888-4888-8888-888888888888",
      conversationId: conversation.id,
      runId: markdownSnapshot.runs[0]!.id,
      seq: 2,
      role: "assistant",
      kind: "assistant_message",
      content: [
        "## 修改结果",
        "",
        "- 已更新布局",
        "- 已保留滚动锚点",
        "",
        "| 项目 | 状态 |",
        "| --- | --- |",
        "| Markdown | 完成 |",
        "",
        "[查看文档](https://example.com/docs)",
        "",
        "```tsx",
        "export const ready = true;",
        "```",
      ].join("\n"),
    });
    const fetchQueue = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: markdownSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "修改结果", level: 2 }),
    ).toBeVisible();
    expect(screen.getByRole("list")).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看文档" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByText("export const ready = true;")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "复制代码" }));

    expect(writeTextSpy).toHaveBeenCalledWith("export const ready = true;");
    expect(screen.getByRole("button", { name: "代码已复制" })).toBeVisible();
  });

  it("流式输出只在用户位于底部时跟随，否则补偿内容高度变化", async () => {
    const runningSnapshot = createSnapshot("running");
    runningSnapshot.events = [];
    const fetchQueue = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        conversations: [conversation],
        snapshot: runningSnapshot,
      }),
    );
    installModelAwareFetchMock(fetchQueue);
    vi.stubGlobal("EventSource", MockEventSource);

    const view = render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={2}
      />,
    );

    await screen.findByText("执行中", { exact: true });
    const transcript = view.container.querySelector(
      ".agent-transcript",
    ) as HTMLDivElement;
    let scrollHeight = 500;
    Object.defineProperty(transcript, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });

    transcript.scrollTop = 300;
    await act(async () => {
      transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
      MockEventSource.instances[0]?.emit(
        "assistant.delta",
        {
          id: "event-scroll-bottom",
          runId: createRun("running").id,
          sequence: 1,
          type: "assistant.delta",
          payload: { text: "第一段" },
          createdAt: new Date().toISOString(),
        },
        "1",
      );
      scrollHeight = 560;
    });
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(560);
    });

    transcript.scrollTop = 120;
    await act(async () => {
      transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
      scrollHeight = 620;
      MockEventSource.instances[0]?.emit(
        "assistant.delta",
        {
          id: "event-scroll-reading",
          runId: createRun("running").id,
          sequence: 2,
          type: "assistant.delta",
          payload: { text: "第二段" },
          createdAt: new Date().toISOString(),
        },
        "2",
      );
    });

    // 非底部状态不跳到 620，而是在原 120 基础上补偿新增的 60px。
    await waitFor(() => {
      expect(transcript.scrollTop).toBe(180);
    });
  });
});
