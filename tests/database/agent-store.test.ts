import { eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { describe, expect, it } from "vitest";

import type { BrowserVerifyResult } from "@/domains/agent/client-tools";
import type { RunPreviewResult } from "@/domains/agent/evidence";
import { AgentStore } from "@/domains/agent/store";
import type { FrozenAgentRunProfile } from "@/domains/agent/types";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import {
  agentEvidence,
  toolInvocations,
  verificationRuns,
  verificationSteps,
} from "@/infrastructure/db/schema";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

const profile: FrozenAgentRunProfile = {
  locale: "zh-CN",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  promptProfile: "webpilot-system-v1",
  promptDigest: "prompt-digest",
  toolsetProfile: "webpilot-files-v1",
  toolsetDigest: "toolset-digest",
  modelProfile: "coding-agent-v1",
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
};

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
        url: "https://5173-webpilot.local",
      },
      errors: [],
      logs: ["[install] ok", "[dev] ready"],
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

function createFailedPreviewResult(
  revision: number,
  kind: "runtime" | "install" = "runtime",
): RunPreviewResult {
  const installFailed = kind === "install";
  return {
    ok: false,
    toolName: "run_preview",
    revision,
    summary: installFailed ? "依赖安装失败。" : "页面产生 1 个运行时错误。",
    build: {
      revision,
      install: {
        status: installFailed ? "failed" : "succeeded",
        exitCode: installFailed ? 1 : 0,
      },
      devServer: {
        status: installFailed ? "not_started" : "ready",
        port: installFailed ? null : 5173,
        url: installFailed ? null : "https://5173-webpilot.local",
      },
      errors: installFailed
        ? ["npm ERR! No matching version found for missing-package@999.0.0"]
        : [],
      logs: installFailed ? ["[install] command failed with exit code 1"] : [],
    },
    runtime: {
      revision,
      rendered: !installFailed,
      events: installFailed
        ? []
        : [
            { type: "RENDER_OK", timestamp: 100 },
            {
              type: "RUNTIME_ERROR",
              message: "Cannot read properties of undefined (reading 'label')",
              stack: "TypeError: Cannot read properties of undefined",
              timestamp: 101,
            },
          ],
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
    // 客户端字段故意始终声称成功；Store 必须依据原始步骤重新计算。
    ok: true,
    toolName: "browser_verify",
    verificationRunId,
    revision,
    replayCount: options.replayCount ?? 0,
    summary: "客户端声称浏览器验证通过。",
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
          durationMs: 12,
          target: { strategy: "test_id", value: "submit" },
          status: "passed",
          message: "已点击提交按钮。",
          error: null,
        },
        {
          index: 1,
          action: "assert_text",
          startedAt: 120,
          durationMs: 18,
          target: null,
          status: assertionPassed ? "passed" : "failed",
          message: assertionPassed ? "页面包含保存成功。" : "未找到保存成功。",
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
      assertions: true,
      revision: true,
    },
  };
}

async function prepareBrowserVerification(
  store: AgentStore<PgQueryResultHKT>,
  input: {
    ownerId: string;
    runId: string;
    projectId: string;
    toolCallId: string;
    revision: number;
    source: "agent" | "replay";
    replayCount: number;
  },
) {
  await store.registerToolInvocation({
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: "browser_verify",
    executionDomain: "client",
    argumentsJson: {
      revision: input.revision,
      steps: browserSmokeSteps,
      acceptedNetworkFailures: [],
      observationMs: 1_500,
    },
    idempotencyKey: `${input.runId}:${input.toolCallId}`,
    revisionBefore: input.revision,
  });
  await store.markToolInvocationRunning({
    runId: input.runId,
    toolCallId: input.toolCallId,
  });
  const verification = await store.createVerificationRun({
    ownerId: input.ownerId,
    runId: input.runId,
    projectId: input.projectId,
    toolCallId: input.toolCallId,
    revision: input.revision,
    source: input.source,
    replayCount: input.replayCount,
    smokeSteps: browserSmokeSteps,
    acceptedNetworkFailures: [],
  });
  await store.transitionRun({
    ownerId: input.ownerId,
    runId: input.runId,
    status: "awaiting_client_tool",
  });
  return verification;
}

describe("AgentStore", () => {
  it("persists a frozen Run, append-only transcript and replayable events", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Agent Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "修改标题",
        userMessage: "请修改页面标题",
        profile,
      });

      expect(run.status).toBe("queued");
      expect(run.startRevision).toBe(1);
      expect(run.promptProfile).toBe("webpilot-system-v1");
      expect(run.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const transcript = await store.listTranscript({
        ownerId: "owner-1",
        conversationId: run.conversationId,
      });
      expect(transcript).toHaveLength(1);
      expect(transcript[0]).toMatchObject({
        kind: "user_message",
        content: "请修改页面标题",
      });

      const firstEvents = await store.listEventsAfter({
        ownerId: "owner-1",
        runId: run.id,
      });
      expect(firstEvents.map((event) => event.type)).toEqual(["run.created"]);

      await store.transitionRun({
        ownerId: "owner-1",
        runId: run.id,
        status: "running",
      });
      const replay = await store.listEventsAfter({
        ownerId: "owner-1",
        runId: run.id,
        cursor: firstEvents[0]?.sequence,
      });
      expect(replay.map((event) => event.type)).toEqual(["run.status_changed"]);
    } finally {
      await testDatabase.close();
    }
  });

  it("deduplicates a tool invocation before side effects", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Ledger Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "读取文件",
        userMessage: "读取 App",
        profile,
      });
      const input = {
        runId: run.id,
        toolCallId: "call-1",
        toolName: "read_file",
        executionDomain: "server" as const,
        argumentsJson: { path: "src/App.tsx" },
        idempotencyKey: `${run.id}:call-1`,
        revisionBefore: 1,
      };

      const first = await store.registerToolInvocation(input);
      const duplicate = await store.registerToolInvocation(input);

      expect(first.created).toBe(true);
      expect(duplicate.created).toBe(false);
      expect(duplicate.invocation.id).toBe(first.invocation.id);
    } finally {
      await testDatabase.close();
    }
  });

  it("原子保存 Client Tool Evidence，并以幂等结果恢复 Run", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Preview Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "运行预览",
        userMessage: "修改并验证页面",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      await store.registerToolInvocation({
        runId: run.id,
        toolCallId: "call-preview",
        toolName: "run_preview",
        executionDomain: "client",
        argumentsJson: { revision: 1, observationMs: 1_500 },
        idempotencyKey: `${run.id}:call-preview`,
        revisionBefore: 1,
      });
      await store.markToolInvocationRunning({
        runId: run.id,
        toolCallId: "call-preview",
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "awaiting_client_tool",
      });
      const result = createPreviewResult(1);

      const accepted = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-preview",
        toolName: "run_preview",
        idempotencyKey: `${run.id}:call-preview`,
        revision: 1,
        result,
      });
      const duplicate = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-preview",
        toolName: "run_preview",
        idempotencyKey: `${run.id}:call-preview`,
        revision: 1,
        result,
      });
      const evidenceRows = await testDatabase.database
        .select()
        .from(agentEvidence)
        .where(eq(agentEvidence.runId, run.id));
      const transcript = await store.listTranscript({
        ownerId: run.ownerId,
        conversationId: run.conversationId,
      });

      expect(accepted.disposition).toBe("accepted");
      expect(accepted.run.status).toBe("running");
      expect(accepted.run.usage).toMatchObject({
        clientResumes: 1,
        repairRounds: 0,
        latestVerificationRevision: 1,
        latestVerificationOk: true,
      });
      expect(accepted.run.usage.firstPreviewAt).toEqual(expect.any(String));
      expect(accepted.run.usage.firstPreviewDurationMs).toEqual(
        expect.any(Number),
      );
      expect(duplicate.disposition).toBe("duplicate");
      expect(evidenceRows.map((row) => row.kind).sort()).toEqual([
        "build",
        "console",
        "runtime",
      ]);
      expect(
        transcript.filter((message) => message.kind === "tool_result"),
      ).toHaveLength(1);
    } finally {
      await testDatabase.close();
    }
  });

  it("记录旧 revision Client Tool Result，但不推进等待中的 Run", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Stale Preview Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "过期预览",
        userMessage: "验证页面",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      await store.updateRunProgress({
        ownerId: run.ownerId,
        runId: run.id,
        currentRevision: 2,
      });
      await store.registerToolInvocation({
        runId: run.id,
        toolCallId: "call-stale",
        toolName: "run_preview",
        executionDomain: "client",
        argumentsJson: { revision: 2, observationMs: 1_500 },
        idempotencyKey: `${run.id}:call-stale`,
        revisionBefore: 2,
      });
      await store.markToolInvocationRunning({
        runId: run.id,
        toolCallId: "call-stale",
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "awaiting_client_tool",
      });

      const ignored = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-stale",
        toolName: "run_preview",
        idempotencyKey: `${run.id}:call-stale`,
        revision: 1,
        result: createPreviewResult(1),
      });
      const latest = await store.getRun({
        ownerId: run.ownerId,
        runId: run.id,
      });
      const events = await store.listEventsAfter({
        ownerId: run.ownerId,
        runId: run.id,
      });

      expect(ignored.disposition).toBe("ignored");
      expect(latest.status).toBe("awaiting_client_tool");
      expect(events.at(-1)).toMatchObject({
        type: "client_tool.result_ignored",
        payload: { reason: "stale_revision" },
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("持久化 Browser Verification，并拒绝客户端伪造成功字段", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const repository = new DatabaseProjectRepository(testDatabase.database);
      const project = await repository.createProject({
        ownerId: "owner-1",
        name: "Browser Verification Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "浏览器验证",
        userMessage: "提交表单并断言成功提示",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      const verification = await prepareBrowserVerification(store, {
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-browser-forged",
        revision: 1,
        source: "agent",
        replayCount: 0,
      });

      const completion = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-browser-forged",
        toolName: "browser_verify",
        idempotencyKey: `${run.id}:call-browser-forged`,
        revision: 1,
        result: createBrowserResult(verification.id, 1, {
          assertionPassed: false,
        }),
      });
      const [ledger] = await testDatabase.database
        .select()
        .from(toolInvocations)
        .where(eq(toolInvocations.toolCallId, "call-browser-forged"));
      const [verificationRow] = await testDatabase.database
        .select()
        .from(verificationRuns)
        .where(eq(verificationRuns.id, verification.id));
      const stepRows = await testDatabase.database
        .select()
        .from(verificationSteps)
        .where(eq(verificationSteps.verificationRunId, verification.id));

      expect(completion.run).toMatchObject({
        status: "running",
        usage: {
          clientResumes: 1,
          repairRounds: 0,
          latestVerificationOk: false,
        },
      });
      expect(ledger).toMatchObject({
        status: "failed",
        errorCode: "BROWSER_VERIFICATION_FAILED",
        resultJson: {
          ok: false,
          checks: { assertions: false },
        },
      });
      expect(verificationRow).toMatchObject({
        status: "failed",
        assertionsOk: false,
        failedStep: 1,
      });
      expect(stepRows).toHaveLength(2);
      expect(stepRows[1]).toMatchObject({
        stepIndex: 1,
        action: "assert_text",
        status: "failed",
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("旧 revision 的 Browser 结果不能恢复或验证当前 revision", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const repository = new DatabaseProjectRepository(testDatabase.database);
      const project = await repository.createProject({
        ownerId: "owner-1",
        name: "Stale Browser Verification",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "过期浏览器验证",
        userMessage: "验证当前页面",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      await store.updateRunProgress({
        ownerId: run.ownerId,
        runId: run.id,
        currentRevision: 2,
      });
      const verification = await prepareBrowserVerification(store, {
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-browser-stale",
        revision: 2,
        source: "agent",
        replayCount: 0,
      });

      const ignored = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-browser-stale",
        toolName: "browser_verify",
        idempotencyKey: `${run.id}:call-browser-stale`,
        revision: 1,
        result: createBrowserResult(verification.id, 1),
      });
      const latest = await store.getRun({
        ownerId: run.ownerId,
        runId: run.id,
      });
      const [verificationRow] = await testDatabase.database
        .select()
        .from(verificationRuns)
        .where(eq(verificationRuns.id, verification.id));

      expect(ignored.disposition).toBe("ignored");
      expect(latest).toMatchObject({
        status: "awaiting_client_tool",
        currentRevision: 2,
        usage: { clientResumes: 0, latestVerificationOk: null },
      });
      expect(verificationRow).toMatchObject({
        status: "running",
        revisionOk: null,
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("项目已产生新 revision 时拒绝旧 Browser 成功结果", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const repository = new DatabaseProjectRepository(testDatabase.database);
      const project = await repository.createProject({
        ownerId: "owner-1",
        name: "Repository Revision Fence",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "仓库 revision 栅栏",
        userMessage: "验证当前页面",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      const verification = await prepareBrowserVerification(store, {
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-browser-repository-stale",
        revision: project.revision,
        source: "agent",
        replayCount: 0,
      });

      // 模拟 Browser Verify 正在 revision 1 上运行时，用户从编辑器保存了新内容。
      // Agent Run 尚未来得及同步 revision，因此必须直接读取项目表阻止旧证据落库。
      const mutation = await repository.writeFile({
        ownerId: run.ownerId,
        projectId: project.id,
        path: "src/App.tsx",
        content: "export default function App() { return 'revision 2'; }",
        expectedRevision: project.revision,
      });
      expect(mutation.revision).toBe(2);

      const ignored = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-browser-repository-stale",
        toolName: "browser_verify",
        idempotencyKey: `${run.id}:call-browser-repository-stale`,
        revision: project.revision,
        result: createBrowserResult(verification.id, project.revision),
      });
      const latest = await store.getRun({
        ownerId: run.ownerId,
        runId: run.id,
      });
      const [verificationRow] = await testDatabase.database
        .select()
        .from(verificationRuns)
        .where(eq(verificationRuns.id, verification.id));
      const events = await store.listEventsAfter({
        ownerId: run.ownerId,
        runId: run.id,
      });

      expect(ignored.disposition).toBe("ignored");
      expect(latest).toMatchObject({
        status: "awaiting_client_tool",
        currentRevision: project.revision,
        usage: { clientResumes: 0, latestVerificationOk: null },
      });
      expect(verificationRow).toMatchObject({
        status: "running",
        revisionOk: null,
      });
      expect(events.at(-1)).toMatchObject({
        type: "client_tool.result_ignored",
        payload: {
          reason: "stale_revision",
          submittedRevision: project.revision,
          currentRevision: project.revision,
          repositoryRevision: mutation.revision,
        },
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("自动重放只保存 Verification facts，不制造孤立 Transcript tool result", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const repository = new DatabaseProjectRepository(testDatabase.database);
      const project = await repository.createProject({
        ownerId: "owner-1",
        name: "Replay Transcript Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "自动重放",
        userMessage: "修复后自动验证",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      const verification = await prepareBrowserVerification(store, {
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "replay:call-write:1",
        revision: 1,
        source: "replay",
        replayCount: 1,
      });

      await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "replay:call-write:1",
        toolName: "browser_verify",
        idempotencyKey: `${run.id}:replay:call-write:1`,
        revision: 1,
        result: createBrowserResult(verification.id, 1, { replayCount: 1 }),
      });
      const transcript = await store.listTranscript({
        ownerId: run.ownerId,
        conversationId: run.conversationId,
      });
      const snapshot = await store.getConversationSnapshot({
        ownerId: run.ownerId,
        conversationId: run.conversationId,
      });

      expect(
        transcript.filter((message) => message.kind === "tool_result"),
      ).toHaveLength(0);
      expect(snapshot.verificationRuns).toEqual([
        expect.objectContaining({
          id: verification.id,
          status: "passed",
          source: "replay",
          replayCount: 1,
        }),
      ]);
      expect(snapshot.verificationSteps).toHaveLength(2);
    } finally {
      await testDatabase.close();
    }
  });

  it("连续修复时沿用 canonical smoke plan，并递增最新 replay 次数", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const repository = new DatabaseProjectRepository(testDatabase.database);
      const project = await repository.createProject({
        ownerId: "owner-1",
        name: "Repeated Replay Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "连续修复",
        userMessage: "持续修复直到通过",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });

      const canonical = await prepareBrowserVerification(store, {
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-canonical",
        revision: 1,
        source: "agent",
        replayCount: 0,
      });
      await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-canonical",
        toolName: "browser_verify",
        idempotencyKey: `${run.id}:call-canonical`,
        revision: 1,
        result: createBrowserResult(canonical.id, 1, {
          assertionPassed: false,
        }),
      });
      await store.updateRunProgress({
        ownerId: run.ownerId,
        runId: run.id,
        currentRevision: 2,
      });

      const replay = await prepareBrowserVerification(store, {
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "replay:call-write:2",
        revision: 2,
        source: "replay",
        replayCount: 1,
      });
      await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "replay:call-write:2",
        toolName: "browser_verify",
        idempotencyKey: `${run.id}:replay:call-write:2`,
        revision: 2,
        result: createBrowserResult(replay.id, 2, {
          assertionPassed: false,
          replayCount: 1,
        }),
      });
      await store.updateRunProgress({
        ownerId: run.ownerId,
        runId: run.id,
        currentRevision: 3,
      });

      const plan = await store.findReplayableSmokePlan({
        ownerId: run.ownerId,
        runId: run.id,
        currentRevision: 3,
      });

      expect(plan).toMatchObject({
        id: canonical.id,
        source: "agent",
        replayCount: 1,
        smokeSteps: browserSmokeSteps,
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("Run 取消后忽略迟到 Preview 结果，不能恢复执行", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Cancelled Preview Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "取消预览",
        userMessage: "验证页面",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });
      await store.registerToolInvocation({
        runId: run.id,
        toolCallId: "call-late-preview",
        toolName: "run_preview",
        executionDomain: "client",
        argumentsJson: { revision: 1, observationMs: 1_500 },
        idempotencyKey: `${run.id}:call-late-preview`,
        revisionBefore: 1,
      });
      await store.markToolInvocationRunning({
        runId: run.id,
        toolCallId: "call-late-preview",
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "awaiting_client_tool",
      });
      await store.requestCancellation({
        ownerId: run.ownerId,
        runId: run.id,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "cancelled",
      });

      const late = await store.completeClientToolResult({
        ownerId: run.ownerId,
        runId: run.id,
        projectId: project.id,
        toolCallId: "call-late-preview",
        toolName: "run_preview",
        idempotencyKey: `${run.id}:call-late-preview`,
        revision: 1,
        result: createPreviewResult(1),
      });
      const latest = await store.getRun({
        ownerId: run.ownerId,
        runId: run.id,
      });

      expect(late.disposition).toBe("ignored");
      expect(latest.status).toBe("cancelled");
      expect(latest.usage.clientResumes).toBe(0);
    } finally {
      await testDatabase.close();
    }
  });

  it("保存结构化 install failure，并停止同 revision 的重复无进展循环", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "No Progress Preview Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "重复失败",
        userMessage: "修复安装错误",
        profile,
      });
      await store.transitionRun({
        ownerId: run.ownerId,
        runId: run.id,
        status: "running",
      });

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const toolCallId = `call-install-${attempt}`;
        await store.registerToolInvocation({
          runId: run.id,
          toolCallId,
          toolName: "run_preview",
          executionDomain: "client",
          argumentsJson: { revision: 1, observationMs: 1_500 },
          idempotencyKey: `${run.id}:${toolCallId}`,
          revisionBefore: 1,
        });
        await store.markToolInvocationRunning({
          runId: run.id,
          toolCallId,
        });
        await store.transitionRun({
          ownerId: run.ownerId,
          runId: run.id,
          status: "awaiting_client_tool",
        });
        const completion = await store.completeClientToolResult({
          ownerId: run.ownerId,
          runId: run.id,
          projectId: project.id,
          toolCallId,
          toolName: "run_preview",
          idempotencyKey: `${run.id}:${toolCallId}`,
          revision: 1,
          result: createFailedPreviewResult(1, "install"),
        });

        expect(completion.run.status).toBe(
          attempt === 3 ? "budget_exhausted" : "running",
        );
      }

      const latest = await store.getRun({
        ownerId: run.ownerId,
        runId: run.id,
      });
      const transcript = await store.listTranscript({
        ownerId: run.ownerId,
        conversationId: run.conversationId,
      });
      const previewResults = transcript.filter(
        (message) =>
          message.kind === "tool_result" && message.toolName === "run_preview",
      );

      expect(latest).toMatchObject({
        status: "budget_exhausted",
        errorCode: "AGENT_NO_PROGRESS",
        usage: {
          clientResumes: 3,
          repairRounds: 2,
          repeatedFailureCount: 2,
          latestVerificationOk: false,
        },
      });
      expect(previewResults[0]).toMatchObject({
        kind: "tool_result",
        resultJson: {
          verificationFailure: {
            code: "install_failed",
            stage: "install",
            issues: [
              {
                message: expect.stringContaining("No matching version"),
              },
            ],
          },
        },
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("restores one conversation snapshot with transcript, runs, events and tools", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Snapshot Project",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const firstRun = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "第一次修改",
        userMessage: "先读取 App",
        profile,
      });

      await store.appendTranscript({
        conversationId: firstRun.conversationId,
        runId: firstRun.id,
        role: "assistant",
        kind: "tool_call",
        toolCallId: "call-read",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      });
      await store.appendEvent({
        runId: firstRun.id,
        type: "tool.started",
        payload: { toolCallId: "call-read", toolName: "read_file" },
      });
      const ledger = await store.registerToolInvocation({
        runId: firstRun.id,
        toolCallId: "call-read",
        toolName: "read_file",
        executionDomain: "server",
        argumentsJson: { path: "src/App.tsx" },
        idempotencyKey: `${firstRun.id}:call-read`,
        revisionBefore: 1,
      });
      await store.markToolInvocationRunning({
        runId: firstRun.id,
        toolCallId: "call-read",
      });
      await store.completeToolInvocation({
        runId: firstRun.id,
        toolCallId: "call-read",
        status: "succeeded",
        resultJson: {
          ok: true,
          toolName: "read_file",
          revision: 1,
          data: { file: { path: "src/App.tsx" } },
        },
        revisionAfter: 1,
      });
      await store.transitionRun({
        ownerId: firstRun.ownerId,
        runId: firstRun.id,
        status: "running",
      });
      await store.transitionRun({
        ownerId: firstRun.ownerId,
        runId: firstRun.id,
        status: "succeeded",
      });

      // 同一会话允许连续 Run；快照需要保留历史，而不是只返回最后一次执行。
      const secondRun = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationId: firstRun.conversationId,
        conversationTitle: "第二次修改",
        userMessage: "继续修改页面",
        profile,
      });

      const snapshot = await store.getConversationSnapshot({
        ownerId: "owner-1",
        conversationId: firstRun.conversationId,
      });

      expect(snapshot.conversation.id).toBe(firstRun.conversationId);
      expect(snapshot.runs.map((run) => run.id)).toEqual([
        firstRun.id,
        secondRun.id,
      ]);
      expect(snapshot.transcript.map((message) => message.kind)).toEqual([
        "user_message",
        "tool_call",
        "user_message",
      ]);
      expect(snapshot.events.map((event) => event.type)).toContain(
        "tool.started",
      );
      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0]).toMatchObject({
        id: ledger.invocation.id,
        status: "succeeded",
        toolCallId: "call-read",
      });
      expect(snapshot.verificationRuns).toEqual([]);
      expect(snapshot.verificationSteps).toEqual([]);
    } finally {
      await testDatabase.close();
    }
  });

  it("does not expose a conversation snapshot to another owner", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-a",
        name: "Private Snapshot",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-a",
        projectId: project.id,
        conversationTitle: "私有会话",
        userMessage: "读取项目",
        profile,
      });

      await expect(
        store.getConversationSnapshot({
          ownerId: "owner-b",
          conversationId: run.conversationId,
        }),
      ).rejects.toMatchObject({
        code: "AGENT_RUN_NOT_FOUND",
        status: 404,
      });
    } finally {
      await testDatabase.close();
    }
  });

  it("does not replay a duplicate tool call with different arguments", async () => {
    const testDatabase = await createTestDatabase();

    try {
      const projectRepository = new DatabaseProjectRepository(
        testDatabase.database,
      );
      const project = await projectRepository.createProject({
        ownerId: "owner-1",
        name: "Tool Conflict",
        initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
      });
      const store = new AgentStore(testDatabase.database);
      const run = await store.createRun({
        ownerId: "owner-1",
        projectId: project.id,
        conversationTitle: "重复调用",
        userMessage: "读取 App",
        profile,
      });
      const first = await store.registerToolInvocation({
        runId: run.id,
        toolCallId: "call-1",
        toolName: "read_file",
        executionDomain: "server",
        argumentsJson: { path: "src/App.tsx" },
        idempotencyKey: `${run.id}:call-1`,
        revisionBefore: 1,
      });

      await store.markToolInvocationRunning({
        runId: run.id,
        toolCallId: "call-1",
      });
      await store.completeToolInvocation({
        runId: run.id,
        toolCallId: "call-1",
        status: "succeeded",
        resultJson: {
          ok: true,
          toolName: "read_file",
          revision: 1,
          data: {},
        },
      });

      const duplicate = await store.registerToolInvocation({
        runId: run.id,
        toolCallId: "call-1",
        toolName: "read_file",
        executionDomain: "server",
        argumentsJson: { path: "src/Other.tsx" },
        idempotencyKey: `${run.id}:call-1`,
        revisionBefore: 1,
      });

      expect(duplicate.created).toBe(false);
      expect(duplicate.invocation.id).toBe(first.invocation.id);
      expect(duplicate.invocation.argumentsJson).toEqual({
        path: "src/App.tsx",
      });
    } finally {
      await testDatabase.close();
    }
  });
});
