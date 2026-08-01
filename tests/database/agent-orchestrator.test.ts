import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { BrowserVerifyResult } from "@/domains/agent/client-tools";
import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import type { RunPreviewResult } from "@/domains/agent/evidence";
import type { FileToolResultEnvelope } from "@/domains/agent/file-tools";
import { FileToolExecutor } from "@/domains/agent/file-tools";
import { AgentOrchestrator } from "@/domains/agent/orchestrator";
import {
  createFrozenAgentProfile,
  resolveSystemPromptProfile,
  resolveToolsetProfile,
} from "@/domains/agent/profiles";
import type {
  LlmProvider,
  ProviderEvent,
  ProviderTurnInput,
} from "@/domains/agent/provider";
import { AgentStore } from "@/domains/agent/store";
import type { AgentRunBudget } from "@/domains/agent/types";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import {
  agentRuns,
  projectChangeSets,
  projectCheckpoints,
} from "@/infrastructure/db/schema";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

class ScriptedProvider implements LlmProvider {
  readonly inputs: ProviderTurnInput[] = [];

  constructor(private readonly turns: readonly ProviderEvent[][]) {}

  async *streamTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    this.inputs.push(input);
    const turn = this.turns[this.inputs.length - 1];

    if (!turn) {
      throw new Error("测试 Provider 缺少下一轮脚本。");
    }

    for (const event of turn) {
      yield event;
    }
  }
}

class LeaseTakeoverProvider implements LlmProvider {
  readonly inputs: ProviderTurnInput[] = [];

  constructor(
    private readonly onTurn: () => Promise<void>,
    private readonly terminalError: Error,
  ) {}

  async *streamTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    this.inputs.push(input);
    await this.onTurn();
    throw this.terminalError;
  }
}

async function createFixture(
  options: {
    maxModelTurns?: number;
    promptDigest?: string;
    budget?: Partial<AgentRunBudget>;
    profileVersion?: "m3" | "m4";
    initialFiles?: readonly { path: string; content: string }[];
  } = {},
) {
  const testDatabase = await createTestDatabase();
  const repository = new DatabaseProjectRepository(testDatabase.database);
  const project = await repository.createProject({
    ownerId: "owner-1",
    name: "Agent Orchestrator",
    initialFiles: options.initialFiles ?? [
      {
        path: "src/App.tsx",
        content: "export default function App() { return <h1>旧标题</h1>; }",
      },
    ],
  });
  const profile = createFrozenAgentProfile({
    locale: "zh-CN",
    projectId: project.id,
    revision: project.revision,
    repositoryCapability: {
      storageKind: "database",
      canRead: true,
      canWrite: true,
      canExecuteServerTools: true,
    },
    provider: "deepseek",
    model: "deepseek-v4-pro",
    maxModelTurns: options.maxModelTurns ?? 6,
    maxWallTimeSeconds: 300,
  });
  const frozenProfile =
    options.profileVersion === "m3"
      ? createM3Profile(profile, project.id, project.revision)
      : profile;
  const store = new AgentStore(testDatabase.database);
  const run = await store.createRun({
    ownerId: "owner-1",
    projectId: project.id,
    conversationTitle: "修改页面",
    userMessage: "请修改页面标题",
    profile: {
      ...frozenProfile,
      budget: { ...frozenProfile.budget, ...options.budget },
      ...(options.promptDigest ? { promptDigest: options.promptDigest } : {}),
    },
  });

  return {
    testDatabase,
    repository,
    store,
    run,
    fileTools: new FileToolExecutor(repository, store),
  };
}

function createM3Profile(
  profile: ReturnType<typeof createFrozenAgentProfile>,
  projectId: string,
  revision: number,
) {
  const prompt = resolveSystemPromptProfile("webpilot-system-v3", {
    locale: profile.locale,
    projectId,
    revision,
    repositoryCapability: profile.repositoryCapability,
  });
  const toolset = resolveToolsetProfile("webpilot-preview-v2");

  return {
    ...profile,
    promptProfile: prompt.id,
    promptDigest: prompt.digest,
    toolsetProfile: toolset.id,
    toolsetDigest: toolset.digest,
  };
}

function createPreviewResult(revision: number): RunPreviewResult {
  return {
    ok: true,
    toolName: "run_preview",
    revision,
    durationMs: 1_234,
    summary: "Preview 验证通过。",
    build: {
      revision,
      install: { status: "succeeded", exitCode: 0 },
      devServer: {
        status: "ready",
        port: 5173,
        url: "https://preview.example",
      },
      errors: [],
      logs: [],
    },
    runtime: {
      revision,
      rendered: true,
      events: [{ type: "RENDER_OK", timestamp: 100 }],
      diagnostics: [],
    },
    console: {
      revision,
      entries: [],
      totalBytes: 0,
      truncated: false,
    },
  };
}

const browserSmokeSteps = [
  {
    action: "click" as const,
    target: { strategy: "test_id" as const, value: "submit" },
  },
  {
    action: "assert_text" as const,
    text: "保存成功",
  },
];

function createBrowserResult(
  verificationRunId: string,
  revision: number,
  options: {
    assertionPassed?: boolean;
    replayCount?: number;
  } = {},
): BrowserVerifyResult {
  const assertionPassed = options.assertionPassed ?? true;

  return {
    ok: assertionPassed,
    toolName: "browser_verify",
    verificationRunId,
    revision,
    replayCount: options.replayCount ?? 0,
    durationMs: 3_456,
    summary: assertionPassed ? "验证通过。" : "提交后 UI 未更新。",
    build: {
      revision,
      install: { status: "succeeded", exitCode: 0 },
      devServer: {
        status: "ready",
        port: 5173,
        url: "https://preview.example",
      },
      errors: [],
      logs: [],
    },
    runtime: {
      revision,
      rendered: true,
      events: [{ type: "RENDER_OK", timestamp: 100 }],
      diagnostics: [],
    },
    console: {
      revision,
      entries: [],
      totalBytes: 0,
      truncated: false,
    },
    browser: {
      revision,
      sessionId: `session-${revision}`,
      ok: assertionPassed,
      steps: [
        {
          index: 0,
          action: "click",
          startedAt: 100,
          durationMs: 10,
          target: { strategy: "test_id", value: "submit" },
          status: "passed",
          message: "提交按钮已点击。",
          error: null,
        },
        {
          index: 1,
          action: "assert_text",
          startedAt: 120,
          durationMs: 15,
          target: null,
          status: assertionPassed ? "passed" : "failed",
          message: assertionPassed ? "成功提示可见。" : "成功提示不可见。",
          error: assertionPassed
            ? null
            : {
                code: "assertion_failed",
                message: "页面未出现保存成功。",
              },
        },
      ],
      failedStep: assertionPassed ? null : 1,
      domContext: null,
    },
    network: {
      revision,
      sessionId: `session-${revision}`,
      entries: [],
      totalBytes: 0,
      truncated: false,
      includesSuccessful: false,
    },
    acceptedNetworkFailures: [],
    checks: {
      build: true,
      runtime: true,
      console: true,
      network: true,
      actions: true,
      assertions: assertionPassed,
      revision: true,
    },
  };
}

describe("AgentOrchestrator", () => {
  it("模型流输出半句后中断时丢弃临时文本并在预算内重试", async () => {
    const fixture = await createFixture({ maxModelTurns: 3 });
    let turnIndex = 0;
    const provider: LlmProvider = {
      async *streamTurn(input) {
        turnIndex += 1;

        if (turnIndex === 1) {
          yield { type: "text_delta", text: "好的，我先查看当前项目。" };
          throw new AgentError(
            AGENT_ERROR_CODES.providerTimeout,
            "DeepSeek 流已开始，但长时间没有返回新数据。",
            504,
          );
        }

        if (turnIndex === 2) {
          yield {
            type: "tool_call_delta",
            index: 0,
            toolCallId: "call-list-after-stream-retry",
            toolName: "list_files",
            argumentsDelta: "{}",
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }

        yield {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-browser-after-stream-retry",
          toolName: "browser_verify",
          argumentsDelta: JSON.stringify({
            revision: 1,
            steps: [
              {
                action: "assert_text",
                text: "旧标题",
                target: { strategy: "css", selector: "h1" },
              },
            ],
          }),
        };
        yield { type: "finish", reason: "tool_calls" };
        void input;
      },
    };

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });

      expect(snapshot.runs.at(-1)).toMatchObject({
        status: "awaiting_client_tool",
        usage: { modelTurns: 3 },
      });
      expect(
        snapshot.events.filter((event) => event.type === "model.turn_retried"),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            reason: "provider_stream_interrupted",
            errorCode: AGENT_ERROR_CODES.providerTimeout,
            discardedCharacterCount: 12,
            retryAttempt: 1,
            consumedModelTurns: 1,
          }),
        }),
      ]);
      expect(
        snapshot.transcript.filter(
          (message) => message.kind === "assistant_message",
        ),
      ).toEqual([]);
      expect(snapshot.tools.at(-1)).toMatchObject({
        toolCallId: "call-browser-after-stream-retry",
        status: "running",
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("供应商遗漏 Tool Call 数据时丢弃临时文本并按同一 Transcript 有界重试", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "我先检查项目结构。" },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-list-after-retry",
          toolName: "list_files",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-browser-after-retry",
          toolName: "browser_verify",
          argumentsDelta: JSON.stringify({
            revision: 1,
            steps: [
              {
                action: "assert_text",
                text: "旧标题",
                target: { strategy: "css", selector: "h1" },
              },
            ],
          }),
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });

      expect(snapshot.runs.at(-1)).toMatchObject({
        status: "awaiting_client_tool",
        usage: { modelTurns: 3 },
      });
      expect(
        snapshot.events.filter((event) => event.type === "model.turn_retried"),
      ).toEqual([
        expect.objectContaining({
          payload: {
            reason: "empty_tool_calls",
            discardedCharacterCount: 9,
            consumedModelTurns: 1,
          },
        }),
      ]);
      expect(
        snapshot.transcript.filter(
          (message) => message.kind === "assistant_message",
        ),
      ).toEqual([]);
      expect(provider.inputs[1]?.messages).toEqual(
        provider.inputs[0]?.messages,
      );
      expect(provider.inputs[2]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-list-after-retry",
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("空项目先写齐完整骨架并自检，最后才请求 run_preview", async () => {
    const fixture = await createFixture({
      initialFiles: [],
      maxModelTurns: 8,
    });
    const packageJson = JSON.stringify({
      name: "blank-project",
      private: true,
      type: "module",
      scripts: {
        dev: "RSPACK_BINDING=@rspack/binding-wasm32-wasi rsbuild dev",
        build: "RSPACK_BINDING=@rspack/binding-wasm32-wasi rsbuild build",
      },
      dependencies: {
        "@rsbuild/core": "2.1.8",
        "@rsbuild/plugin-react": "2.1.0",
        "@rspack/core": "2.1.5",
        "@rspack/binding-wasm32-wasi": "2.1.5",
        "@types/react": "19.2.17",
        "@types/react-dom": "19.2.3",
        react: "19.2.4",
        "react-dom": "19.2.4",
        typescript: "5.9.3",
      },
    });
    const writes = [
      {
        path: "package.json",
        content: packageJson,
        expectedRevision: 0,
      },
      {
        path: "index.html",
        content: '<div id="root"></div>',
        expectedRevision: 1,
      },
      {
        path: "rsbuild.config.ts",
        content:
          'import { defineConfig } from "@rsbuild/core";\nimport { pluginReact } from "@rsbuild/plugin-react";\nexport default defineConfig({ plugins: [pluginReact()] });',
        expectedRevision: 2,
      },
      {
        path: "tsconfig.json",
        content: '{"compilerOptions":{"jsx":"react-jsx"}}',
        expectedRevision: 3,
      },
      {
        path: "src/index.tsx",
        content:
          'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<h1>Blank project</h1>);',
        expectedRevision: 4,
      },
    ];
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-list-empty",
          toolName: "list_files",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      ...writes.map((write, index) => [
        {
          type: "tool_call_delta" as const,
          index: 0,
          toolCallId: `call-write-${index + 1}`,
          toolName: "write_file",
          argumentsDelta: JSON.stringify(write),
        },
        { type: "finish" as const, reason: "tool_calls" as const },
      ]),
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-list-complete",
          toolName: "list_files",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-preview-complete",
          toolName: "run_preview",
          argumentsDelta: '{"revision":5,"observationMs":1500}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const finalListResult = snapshot.transcript.find(
        (message) =>
          message.kind === "tool_result" &&
          message.toolCallId === "call-list-complete",
      );

      expect(snapshot.runs.at(-1)).toMatchObject({
        status: "awaiting_client_tool",
        startRevision: 0,
        currentRevision: 5,
        usage: { modelTurns: 8, fileMutations: 5 },
      });
      expect(snapshot.tools.at(-1)).toMatchObject({
        toolCallId: "call-preview-complete",
        toolName: "run_preview",
        executionDomain: "client",
        status: "running",
        revisionBefore: 5,
      });
      expect(
        snapshot.tools.filter((tool) => tool.executionDomain === "client"),
      ).toHaveLength(1);
      expect(finalListResult).toMatchObject({
        kind: "tool_result",
        resultJson: {
          ok: true,
          revision: 5,
          data: {
            files: expect.arrayContaining(
              writes.map(({ path }) => expect.objectContaining({ path })),
            ),
          },
        },
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("纯文本只读请求正常结束，不启动 Preview 验证循环", async () => {
    const fixture = await createFixture({ maxModelTurns: 1 });
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "已经完成修改说明。" },
        {
          type: "usage",
          inputTokens: 20,
          outputTokens: 8,
          totalTokens: 28,
        },
        { type: "finish", reason: "stop" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const transcript = await fixture.store.listTranscript({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const events = await fixture.store.listEventsAfter({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(run).toMatchObject({
        status: "succeeded",
        usage: { modelTurns: 1, inputTokens: 20, outputTokens: 8 },
      });
      expect(transcript.map((message) => message.kind)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(events.map((event) => event.type)).toContain("assistant.delta");
      expect(events.map((event) => event.type)).not.toContain(
        "verification.completion_blocked",
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: "succeeded" });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("先读取项目再回答的只读请求会在回答后立即结束", async () => {
    const fixture = await createFixture({ maxModelTurns: 2 });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-list-readonly",
          toolName: "list_files",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "当前项目包含一个 App.tsx 文件。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const events = await fixture.store.listEventsAfter({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(run).toMatchObject({
        status: "succeeded",
        usage: { modelTurns: 2, fileMutations: 0 },
      });
      expect(provider.inputs).toHaveLength(2);
      expect(events.map((event) => event.type)).not.toContain(
        "verification.completion_blocked",
      );
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("executes a mutation, suspends for Preview, then succeeds only after matching evidence", async () => {
    // 这条用例冻结在 M3 profile，证明历史 Run 仍按 run_preview 门禁恢复。
    const fixture = await createFixture({ profileVersion: "m3" });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-read",
          toolName: "read_file",
          argumentsDelta: '{"path":"src/App.tsx"}',
        },
        {
          type: "tool_call_delta",
          index: 1,
          toolCallId: "call-write",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"export default function App() { return <h1>新标题</h1>; }","expectedRevision":1}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-preview",
          toolName: "run_preview",
          argumentsDelta: '{"revision":2,"observationMs":1500}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "标题已更新并通过 Preview 验证。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const awaitingRun = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      expect(awaitingRun).toMatchObject({
        status: "awaiting_client_tool",
        currentRevision: 2,
        usage: { modelTurns: 2, fileMutations: 1 },
      });

      await fixture.store.completeClientToolResult({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId: "call-preview",
        toolName: "run_preview",
        idempotencyKey: `${fixture.run.id}:call-preview`,
        revision: 2,
        result: createPreviewResult(2),
      });
      let finalizationAttempts = 0;
      const finalizationWarning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const retryingStore = new Proxy(fixture.store, {
        get(target, property) {
          if (property === "completeSuccessfulRun") {
            return async (
              input: Parameters<typeof fixture.store.completeSuccessfulRun>[0],
            ) => {
              finalizationAttempts += 1;

              // 模拟 Neon 在成功收口事务开始前发生一次瞬时连接错误。第二次调用
              // 仍执行真实事务，用来证明重试不会跳过 checkpoint/ChangeSet 持久化。
              if (finalizationAttempts === 1) {
                throw new Error("temporary Neon connection interruption");
              }

              return target.completeSuccessfulRun(input);
            };
          }

          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await new AgentOrchestrator(
        retryingStore,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const file = await fixture.repository.readFile({
        ownerId: fixture.run.ownerId,
        projectId: fixture.run.projectId,
        path: "src/App.tsx",
      });
      const transcript = await fixture.store.listTranscript({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const successfulCheckpoints = await fixture.testDatabase.database
        .select()
        .from(projectCheckpoints)
        .where(
          and(
            eq(projectCheckpoints.runId, fixture.run.id),
            eq(projectCheckpoints.kind, "agent_success"),
          ),
        );
      const changeSets = await fixture.testDatabase.database
        .select()
        .from(projectChangeSets)
        .where(eq(projectChangeSets.runId, fixture.run.id));

      expect(run).toMatchObject({
        status: "succeeded",
        currentRevision: 2,
        usage: {
          modelTurns: 3,
          fileMutations: 1,
          clientResumes: 1,
          latestVerificationRevision: 2,
          latestVerificationOk: true,
        },
      });
      expect(finalizationAttempts).toBe(2);
      expect(successfulCheckpoints).toHaveLength(1);
      expect(changeSets).toHaveLength(1);
      expect(finalizationWarning).toHaveBeenCalledWith(
        "[agent-orchestrator] retry successful finalization",
        expect.objectContaining({
          runId: fixture.run.id,
          correlationId: fixture.run.correlationId,
        }),
      );
      expect(file.content).toContain("新标题");
      expect(transcript.map((message) => message.kind)).toEqual([
        "user_message",
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
        "tool_call",
        "tool_result",
        "assistant_message",
      ]);
      expect(provider.inputs[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-write",
      });
      expect(provider.inputs[2]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-preview",
      });
      finalizationWarning.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await fixture.testDatabase.close();
    }
  });

  it("客户端工具长时间等待不会消耗服务端 wall-time 预算", async () => {
    const fixture = await createFixture({
      profileVersion: "m3",
      budget: { maxWallTimeSeconds: 1 },
    });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-preview-after-long-wait",
          toolName: "run_preview",
          argumentsDelta: '{"revision":1,"observationMs":1500}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Preview 验证完成。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    try {
      const orchestrator = new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      );
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const waitingRun = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      expect(waitingRun).toMatchObject({
        status: "awaiting_client_tool",
        usage: { activeExecutionStartedAt: null },
      });

      // 模拟浏览器在十分钟后才恢复历史会话并执行 Preview。startedAt 仍是
      // Run 首次启动时间，用例确保它不会再被当成 active execution 预算起点。
      await fixture.testDatabase.database
        .update(agentRuns)
        .set({ startedAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(agentRuns.id, fixture.run.id));

      await fixture.store.completeClientToolResult({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId: "call-preview-after-long-wait",
        toolName: "run_preview",
        idempotencyKey: `${fixture.run.id}:call-preview-after-long-wait`,
        revision: 1,
        result: createPreviewResult(1),
      });
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      await expect(
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        errorCode: null,
        usage: {
          clientResumes: 1,
          activeExecutionStartedAt: null,
        },
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("M4 的 browser_verify 会暂停到客户端，并持久化 canonical smoke plan", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-browser",
          toolName: "browser_verify",
          argumentsDelta: JSON.stringify({
            revision: 1,
            steps: browserSmokeSteps,
            acceptedNetworkFailures: [],
            observationMs: 1_500,
          }),
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const request = snapshot.events.find(
        (event) =>
          event.type === "client_tool.requested" &&
          event.payload.toolCallId === "call-browser",
      );

      expect(run.status).toBe("awaiting_client_tool");
      expect(snapshot.verificationRuns).toEqual([
        expect.objectContaining({
          toolCallId: "call-browser",
          revision: 1,
          source: "agent",
          replayCount: 0,
          smokeSteps: browserSmokeSteps,
        }),
      ]);
      expect(snapshot.tools).toEqual([
        expect.objectContaining({
          toolCallId: "call-browser",
          toolName: "browser_verify",
          executionDomain: "client",
          status: "running",
          revisionBefore: 1,
        }),
      ]);
      expect(request?.payload).toMatchObject({
        toolName: "browser_verify",
        source: "agent",
        replayCount: 0,
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("把非法 browser_verify 参数回喂模型，修正后才创建客户端 Ledger", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-browser-invalid",
          toolName: "browser_verify",
          argumentsDelta: JSON.stringify({
            revision: 1,
            steps: [
              {
                action: "assert_text",
                text: "旧标题",
                target: { strategy: "css", selector: "h1" },
                // 复现真实 DeepSeek Run 生成的越界参数。
                timeoutMs: 20_000,
              },
            ],
          }),
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-browser-corrected",
          toolName: "browser_verify",
          argumentsDelta: JSON.stringify({
            revision: 1,
            steps: [
              {
                action: "assert_text",
                text: "旧标题",
                target: { strategy: "css", selector: "h1" },
                timeoutMs: 5_000,
              },
            ],
          }),
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const [run, snapshot] = await Promise.all([
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
        fixture.store.getConversationSnapshot({
          ownerId: fixture.run.ownerId,
          conversationId: fixture.run.conversationId,
        }),
      ]);
      const invalidResult = snapshot.transcript.find(
        (message) =>
          message.kind === "tool_result" &&
          message.toolCallId === "call-browser-invalid",
      );

      expect(run).toMatchObject({
        status: "awaiting_client_tool",
        usage: { modelTurns: 2, clientResumes: 0 },
      });
      expect(provider.inputs).toHaveLength(2);
      expect(provider.inputs[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-browser-invalid",
        content: expect.stringContaining("AGENT_TOOL_INVALID_ARGUMENTS"),
      });
      expect(invalidResult).toMatchObject({
        kind: "tool_result",
        toolName: "browser_verify",
        resultJson: {
          ok: false,
          revision: 1,
          error: {
            code: AGENT_ERROR_CODES.toolInvalidArguments,
            details: {
              issues: [
                expect.objectContaining({
                  path: ["steps", 0, "timeoutMs"],
                }),
              ],
            },
          },
        },
      });
      expect(snapshot.tools).toEqual([
        expect.objectContaining({
          toolCallId: "call-browser-corrected",
          toolName: "browser_verify",
          executionDomain: "client",
          status: "running",
        }),
      ]);
      expect(
        snapshot.events.filter(
          (event) =>
            event.type === "tool.completed" &&
            event.payload.toolCallId === "call-browser-invalid",
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            ok: false,
            errorCode: AGENT_ERROR_CODES.toolInvalidArguments,
          }),
        }),
      ]);
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("把非法 run_preview 参数回喂模型，而不是直接终止 Run", async () => {
    const fixture = await createFixture({ profileVersion: "m3" });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-preview-invalid",
          toolName: "run_preview",
          argumentsDelta: '{"revision":1,"observationMs":20000}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-preview-corrected",
          toolName: "run_preview",
          argumentsDelta: '{"revision":1,"observationMs":10000}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });

      expect(provider.inputs[1]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-preview-invalid",
        content: expect.stringContaining("AGENT_TOOL_INVALID_ARGUMENTS"),
      });
      expect(snapshot.runs.at(-1)).toMatchObject({
        status: "awaiting_client_tool",
        usage: { modelTurns: 2 },
      });
      expect(snapshot.tools).toEqual([
        expect.objectContaining({
          toolCallId: "call-preview-corrected",
          toolName: "run_preview",
          status: "running",
        }),
      ]);
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("失败 Browser Verify 后 mutation 会自动重放，当前 revision 通过后才完成", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-browser-initial",
          toolName: "browser_verify",
          argumentsDelta: JSON.stringify({
            revision: 1,
            steps: browserSmokeSteps,
            acceptedNetworkFailures: [],
            observationMs: 1_500,
          }),
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-read-repair",
          toolName: "read_file",
          argumentsDelta: '{"path":"src/App.tsx"}',
        },
        {
          type: "tool_call_delta",
          index: 1,
          toolCallId: "call-write-repair",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"export default function App() { return <><button data-testid=\\"submit\\">提交</button><p>保存成功</p></>; }","expectedRevision":1}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "交互问题已修复并通过自动重放。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    try {
      const orchestrator = new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      );
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      let snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const initialVerification = snapshot.verificationRuns[0];
      expect(initialVerification).toBeDefined();

      await fixture.store.completeClientToolResult({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId: "call-browser-initial",
        toolName: "browser_verify",
        idempotencyKey: `${fixture.run.id}:call-browser-initial`,
        revision: 1,
        result: createBrowserResult(initialVerification!.id, 1, {
          assertionPassed: false,
        }),
      });
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      snapshot = await fixture.store.getConversationSnapshot({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const replay = snapshot.verificationRuns.at(-1);
      const replayRequest = snapshot.events.find(
        (event) =>
          event.type === "client_tool.requested" &&
          event.payload.source === "replay",
      );
      expect(replay).toMatchObject({
        revision: 2,
        source: "replay",
        replayCount: 1,
        smokeSteps: browserSmokeSteps,
      });
      expect(replayRequest?.payload).toMatchObject({
        source: "replay",
        replayCount: 1,
        arguments: { revision: 2, steps: browserSmokeSteps },
      });

      await fixture.store.completeClientToolResult({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId: replay!.toolCallId,
        toolName: "browser_verify",
        idempotencyKey: `${fixture.run.id}:${replay!.toolCallId}`,
        revision: 2,
        result: createBrowserResult(replay!.id, 2, { replayCount: 1 }),
      });
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const finalTranscript = await fixture.store.listTranscript({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });
      const replayTranscriptFacts = finalTranscript.filter(
        (message) =>
          (message.kind === "tool_call" || message.kind === "tool_result") &&
          message.toolCallId.startsWith("replay:"),
      );

      expect(run).toMatchObject({
        status: "succeeded",
        currentRevision: 2,
        usage: {
          clientResumes: 2,
          repairRounds: 1,
          latestVerificationRevision: 2,
          latestVerificationOk: true,
        },
      });
      expect(replayTranscriptFacts).toEqual([]);
      expect(provider.inputs[2]?.messages.at(-1)).toMatchObject({
        role: "tool",
        toolCallId: "call-write-repair",
      });
      expect(provider.inputs[2]?.messages[0]).toMatchObject({
        role: "system",
        content: expect.stringContaining(
          "passed the complete browser verification gate",
        ),
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("M4 的 run_preview 成功也不能绕过 Browser Verify 完成门禁", async () => {
    const fixture = await createFixture({
      maxModelTurns: 2,
      profileVersion: "m4",
    });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-preview-only",
          toolName: "run_preview",
          argumentsDelta: '{"revision":1,"observationMs":1500}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Preview 已通过，可以结束。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    try {
      const orchestrator = new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      );
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      await fixture.store.completeClientToolResult({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId: "call-preview-only",
        toolName: "run_preview",
        idempotencyKey: `${fixture.run.id}:call-preview-only`,
        revision: 1,
        result: createPreviewResult(1),
      });
      await orchestrator.run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const events = await fixture.store.listEventsAfter({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(run).toMatchObject({
        status: "budget_exhausted",
        currentRevision: 1,
      });
      expect(events.map((event) => event.type)).toContain(
        "verification.completion_blocked",
      );
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("moves to conflicted when a file tool reports a stale revision", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-conflict",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"changed","expectedRevision":1}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);
    const conflict: FileToolResultEnvelope = {
      ok: false,
      toolName: "write_file",
      conflict: true,
      error: {
        code: AGENT_ERROR_CODES.revisionConflict,
        message: "项目 revision 已变化。",
      },
    };

    try {
      await new AgentOrchestrator(fixture.store, provider, {
        execute: async () => conflict,
      }).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      await expect(
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
      ).resolves.toMatchObject({
        status: "conflicted",
        errorCode: AGENT_ERROR_CODES.revisionConflict,
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("keeps a concurrent user mutation when the Agent reaches a stale write", async () => {
    const fixture = await createFixture();
    let turnCount = 0;
    const provider: LlmProvider = {
      async *streamTurn(input) {
        turnCount += 1;

        if (turnCount === 1) {
          yield {
            type: "tool_call_delta",
            index: 0,
            toolCallId: "call-read-before-conflict",
            toolName: "read_file",
            argumentsDelta: '{"path":"src/App.tsx"}',
          };
          yield { type: "finish", reason: "tool_calls" };
          return;
        }

        // 模拟用户在 Agent 已经读完文件后先完成自己的保存。
        await fixture.repository.writeFile({
          ownerId: fixture.run.ownerId,
          projectId: fixture.run.projectId,
          path: "src/App.tsx",
          content:
            "export default function App() { return <h1>用户最新修改</h1>; }",
          expectedRevision: 1,
        });

        yield {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-stale-write-after-user",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"Agent 不应覆盖","expectedRevision":1}',
        };
        yield { type: "finish", reason: "tool_calls" };
        void input;
      },
    };

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const file = await fixture.repository.readFile({
        ownerId: fixture.run.ownerId,
        projectId: fixture.run.projectId,
        path: "src/App.tsx",
      });
      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(run).toMatchObject({
        status: "conflicted",
        currentRevision: 2,
        errorCode: AGENT_ERROR_CODES.revisionConflict,
      });
      expect(file.content).toContain("用户最新修改");
      expect(file.content).not.toContain("Agent 不应覆盖");
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("moves to budget_exhausted when the model consumes all allowed turns", async () => {
    const fixture = await createFixture({ maxModelTurns: 1 });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-list",
          toolName: "list_files",
          argumentsDelta: "{}",
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      await expect(
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
      ).resolves.toMatchObject({
        status: "budget_exhausted",
        errorCode: AGENT_ERROR_CODES.budgetExhausted,
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("stops before a file mutation that would exceed the frozen mutation budget", async () => {
    const fixture = await createFixture({
      budget: { maxFileMutations: 1 },
    });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-read-first",
          toolName: "read_file",
          argumentsDelta: '{"path":"src/App.tsx"}',
        },
        {
          type: "tool_call_delta",
          index: 1,
          toolCallId: "call-write-first",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"export default function App() { return <h1>第一次修改</h1>; }","expectedRevision":1}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
      [
        {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-read-second",
          toolName: "read_file",
          argumentsDelta: '{"path":"src/App.tsx"}',
        },
        {
          type: "tool_call_delta",
          index: 1,
          toolCallId: "call-write-second",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"export default function App() { return <h1>第二次修改</h1>; }","expectedRevision":2}',
        },
        { type: "finish", reason: "tool_calls" },
      ],
    ]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const file = await fixture.repository.readFile({
        ownerId: fixture.run.ownerId,
        projectId: fixture.run.projectId,
        path: "src/App.tsx",
      });

      expect(run).toMatchObject({
        status: "budget_exhausted",
        currentRevision: 2,
        errorCode: AGENT_ERROR_CODES.budgetExhausted,
        usage: { fileMutations: 1 },
      });
      expect(file.content).toContain("第一次修改");
      expect(file.content).not.toContain("第二次修改");
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("honors a persisted cancellation fence before calling the provider", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([]);

    try {
      await fixture.store.requestCancellation({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(provider.inputs).toHaveLength(0);
      await expect(
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
      ).resolves.toMatchObject({
        status: "cancelled",
        errorCode: AGENT_ERROR_CODES.cancelled,
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("stops before a tool mutation when cancellation arrives during the model turn", async () => {
    const fixture = await createFixture();
    let cancelRequested = false;
    const provider: LlmProvider = {
      async *streamTurn(input) {
        // 模拟用户在 Provider 流式返回期间点击 Stop。
        await fixture.store.requestCancellation({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        });
        cancelRequested = true;
        yield {
          type: "tool_call_delta",
          index: 0,
          toolCallId: "call-write-after-stop",
          toolName: "write_file",
          argumentsDelta:
            '{"path":"src/App.tsx","content":"不应写入","expectedRevision":1}',
        };
        yield { type: "finish", reason: "tool_calls" };
        void input;
      },
    };

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const file = await fixture.repository.readFile({
        ownerId: fixture.run.ownerId,
        projectId: fixture.run.projectId,
        path: "src/App.tsx",
      });
      const run = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(cancelRequested).toBe(true);
      expect(file.content).toContain("旧标题");
      expect(run).toMatchObject({
        status: "cancelled",
        currentRevision: 1,
        errorCode: AGENT_ERROR_CODES.cancelled,
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("fails explicitly when the frozen prompt digest is unavailable", async () => {
    const fixture = await createFixture({ promptDigest: "stale-digest" });
    const provider = new ScriptedProvider([]);

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      expect(provider.inputs).toHaveLength(0);
      await expect(
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
      ).resolves.toMatchObject({
        status: "failed",
        errorCode: AGENT_ERROR_CODES.profileUnavailable,
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("restores an orphaned client tool wait before calling the Provider", async () => {
    const fixture = await createFixture();
    const provider = new ScriptedProvider([]);

    try {
      const initialLeaseId = await fixture.store.claimExecution({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      expect(initialLeaseId).not.toBeNull();
      await fixture.store.transitionRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        status: "running",
      });
      await fixture.store.appendTranscript({
        conversationId: fixture.run.conversationId,
        runId: fixture.run.id,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-browser-recover",
        toolName: "browser_verify",
        argumentsJson: {
          revision: 1,
          steps: browserSmokeSteps,
          acceptedNetworkFailures: [],
          observationMs: 1_500,
        },
      });
      await fixture.store.suspendForClientTool({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId: "call-browser-recover",
        toolName: "browser_verify",
        argumentsJson: {
          revision: 1,
          steps: browserSmokeSteps,
          acceptedNetworkFailures: [],
          observationMs: 1_500,
        },
        idempotencyKey: `${fixture.run.id}:call-browser-recover`,
        revision: 1,
        leaseId: initialLeaseId!,
        source: "agent",
        replayCount: 0,
      });

      // 模拟旧实现抢租约后留下的 running 状态。新的 Orchestrator 应在组装
      // Provider 消息前恢复等待态，避免发出缺少 tool_result 的非法消息链。
      await fixture.testDatabase.database
        .update(agentRuns)
        .set({
          status: "running",
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
        })
        .where(eq(agentRuns.id, fixture.run.id));

      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const [latest, snapshot] = await Promise.all([
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
        fixture.store.getConversationSnapshot({
          ownerId: fixture.run.ownerId,
          conversationId: fixture.run.conversationId,
        }),
      ]);

      expect(provider.inputs).toHaveLength(0);
      expect(latest).toMatchObject({
        status: "awaiting_client_tool",
        executionLeaseId: null,
      });
      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0]).toMatchObject({
        toolCallId: "call-browser-recover",
        executionDomain: "client",
        status: "running",
        resultJson: null,
      });
      expect(snapshot.events.map((event) => event.type)).toContain(
        "client_tool.wait_recovered",
      );
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("旧执行器失去租约后不得用迟到错误覆盖健康的客户端等待态", async () => {
    const fixture = await createFixture();
    const toolCallId = "call-browser-takeover";
    const idempotencyKey = `${fixture.run.id}:${toolCallId}`;
    let latestLeaseId = "";
    const provider = new LeaseTakeoverProvider(async () => {
      const current = await fixture.store.getRun({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      expect(current.executionLeaseId).not.toBeNull();

      // 模拟旧租约到期后另一个实例接管，并已经原子建立同一 browser_verify
      // 等待态。当前 Orchestrator 随后收到 Provider 的迟到错误，也只能退出。
      latestLeaseId = "00000000-0000-4000-8000-000000000002";
      await fixture.testDatabase.database
        .update(agentRuns)
        .set({
          executionLeaseId: latestLeaseId,
          executionLeaseExpiresAt: new Date(Date.now() + 180_000),
        })
        .where(eq(agentRuns.id, fixture.run.id));
      await fixture.store.suspendForClientTool({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        projectId: fixture.run.projectId,
        toolCallId,
        toolName: "browser_verify",
        argumentsJson: {
          revision: 1,
          steps: browserSmokeSteps,
          acceptedNetworkFailures: [],
          observationMs: 1_500,
        },
        idempotencyKey,
        revision: 1,
        leaseId: latestLeaseId,
        source: "agent",
        replayCount: 0,
      });
    }, new Error("旧 Provider 连接迟到中断"));

    try {
      await new AgentOrchestrator(
        fixture.store,
        provider,
        fixture.fileTools,
      ).run({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });

      const [latest, snapshot] = await Promise.all([
        fixture.store.getRun({
          ownerId: fixture.run.ownerId,
          runId: fixture.run.id,
        }),
        fixture.store.getConversationSnapshot({
          ownerId: fixture.run.ownerId,
          conversationId: fixture.run.conversationId,
        }),
      ]);

      expect(provider.inputs).toHaveLength(1);
      expect(latest).toMatchObject({
        status: "awaiting_client_tool",
        executionLeaseId: null,
        errorCode: null,
        errorMessage: null,
      });
      expect(snapshot.tools).toEqual([
        expect.objectContaining({
          toolCallId,
          toolName: "browser_verify",
          executionDomain: "client",
          status: "running",
        }),
      ]);
      expect(
        snapshot.events.filter(
          (event) => event.type === "client_tool.requested",
        ),
      ).toHaveLength(1);
      expect(
        snapshot.events.some(
          (event) =>
            event.type === "run.status_changed" &&
            event.payload.status === "failed",
        ),
      ).toBe(false);
    } finally {
      await fixture.testDatabase.close();
    }
  });
});

describe("AgentStore execution lease", () => {
  it("prevents duplicate execution and allows reclaim after expiration", async () => {
    const fixture = await createFixture();

    try {
      const first = await fixture.store.claimExecution({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        leaseMilliseconds: 10,
      });
      const duplicate = await fixture.store.claimExecution({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        leaseMilliseconds: 10,
      });

      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(duplicate).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 30));
      const reclaimed = await fixture.store.claimExecution({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
        leaseMilliseconds: 10,
      });

      expect(reclaimed).not.toBe(first);
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("maps the active-project unique index to a stable Run conflict", async () => {
    const fixture = await createFixture();

    try {
      await expect(
        fixture.store.createRun({
          ownerId: fixture.run.ownerId,
          projectId: fixture.run.projectId,
          conversationTitle: "第二个 Run",
          userMessage: "并发请求",
          profile: createFrozenAgentProfile({
            locale: "zh-CN",
            projectId: fixture.run.projectId,
            revision: fixture.run.startRevision,
            repositoryCapability: fixture.run.repositoryCapability,
            provider: "deepseek",
            model: "deepseek-v4-pro",
            maxModelTurns: 6,
            maxWallTimeSeconds: 300,
          }),
        }),
      ).rejects.toMatchObject({
        code: AGENT_ERROR_CODES.runConflict,
        status: 409,
      });

      const rows = await fixture.testDatabase.database
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.projectId, fixture.run.projectId));
      expect(rows).toHaveLength(1);
    } finally {
      await fixture.testDatabase.close();
    }
  });
});
