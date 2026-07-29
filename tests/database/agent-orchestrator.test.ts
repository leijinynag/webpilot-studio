import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { BrowserVerifyResult } from "@/domains/agent/client-tools";
import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
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
import { agentRuns } from "@/infrastructure/db/schema";
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

async function createFixture(
  options: {
    maxModelTurns?: number;
    promptDigest?: string;
    budget?: Partial<AgentRunBudget>;
    profileVersion?: "m3" | "m4";
  } = {},
) {
  const testDatabase = await createTestDatabase();
  const repository = new DatabaseProjectRepository(testDatabase.database);
  const project = await repository.createProject({
    ownerId: "owner-1",
    name: "Agent Orchestrator",
    initialFiles: [
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
  it("persists streamed text but blocks completion without matching Preview evidence", async () => {
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
        status: "budget_exhausted",
        usage: { modelTurns: 1, inputTokens: 20, outputTokens: 8 },
      });
      expect(transcript.map((message) => message.kind)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(events.map((event) => event.type)).toContain("assistant.delta");
      expect(events.map((event) => event.type)).toContain(
        "verification.completion_blocked",
      );
      expect(events.at(-1)?.payload).toMatchObject({
        status: "budget_exhausted",
      });
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
      const transcript = await fixture.store.listTranscript({
        ownerId: fixture.run.ownerId,
        conversationId: fixture.run.conversationId,
      });

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
      expect(request?.payload).toMatchObject({
        toolName: "browser_verify",
        source: "agent",
        replayCount: 0,
      });
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
