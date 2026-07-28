import { describe, expect, it } from "vitest";

import { AgentStore } from "@/domains/agent/store";
import type { FrozenAgentRunProfile } from "@/domains/agent/types";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

const profile: FrozenAgentRunProfile = {
  locale: "zh-CN",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  promptProfile: "webpilot-system-v1",
  promptDigest: "prompt-digest",
  toolsetProfile: "webpilot-files-v1",
  toolsetDigest: "toolset-digest",
  modelProfile: "deepseek-agent-v1",
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
});
