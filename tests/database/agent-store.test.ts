import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { RunPreviewResult } from "@/domains/agent/evidence";
import { AgentStore } from "@/domains/agent/store";
import type { FrozenAgentRunProfile } from "@/domains/agent/types";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import { agentEvidence } from "@/infrastructure/db/schema";
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
