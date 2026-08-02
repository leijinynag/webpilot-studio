import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentPanel } from "@/components/workbench/agent-panel";
import {
  EMPTY_AGENT_RUN_USAGE,
  type AgentConversationSnapshot,
  type AgentRunRecord,
  type ConversationRecord,
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

describe("AgentPanel", () => {
  afterEach(() => {
    cleanup();
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
    vi.stubGlobal("fetch", fetchMock);
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
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(String(MockEventSource.instances[0]?.url)).toContain("?cursor=12");

    await act(async () => {
      MockEventSource.instances[0]?.emitError();
    });

    expect(await screen.findByText("已完成", { exact: true })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "停止" }),
    ).not.toBeInTheDocument();
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
    vi.stubGlobal("fetch", fetchMock);
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
    expect(screen.getByText("我先检查项目结构。")).toBeVisible();

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
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", MockEventSource);

    render(
      <AgentPanel
        dirtyPaths={[]}
        onRestoreComplete={vi.fn()}
        projectId={conversation.projectId}
        revision={0}
      />,
    );

    expect(await screen.findByText("正在请求模型规划下一步")).toBeVisible();
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

    expect(screen.getByText("模型已响应，正在完成当前步骤")).toBeVisible();
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
    vi.stubGlobal("fetch", fetchMock);
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

    expect(screen.getByText("12345678")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(
      () => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 1_000 },
    );
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
    await user.click(screen.getByRole("button", { name: "2 个会话" }));
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
});
