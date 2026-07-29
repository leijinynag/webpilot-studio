import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import { FileToolExecutor } from "@/domains/agent/file-tools";
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

async function createFixture() {
  const testDatabase = await createTestDatabase();
  const repository = new DatabaseProjectRepository(testDatabase.database);
  const project = await repository.createProject({
    ownerId: "owner-1",
    name: "Tool Project",
    initialFiles: [{ path: "src/App.tsx", content: "export default App" }],
  });
  const store = new AgentStore(testDatabase.database);
  const run = await store.createRun({
    ownerId: "owner-1",
    projectId: project.id,
    conversationTitle: "文件工具",
    userMessage: "修改 App",
    profile,
  });

  return {
    testDatabase,
    repository,
    store,
    run,
    executor: new FileToolExecutor(repository, store),
  };
}

describe("FileToolExecutor", () => {
  it("rejects unknown fields with a stable result envelope", async () => {
    const fixture = await createFixture();

    try {
      const result = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-invalid",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx", unexpected: true },
      });

      expect(result).toMatchObject({
        ok: false,
        conflict: false,
        error: { code: AGENT_ERROR_CODES.toolInvalidArguments },
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("requires a successful read at the same revision before updating", async () => {
    const fixture = await createFixture();

    try {
      const rejected = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-write-before-read",
        toolName: "write_file",
        argumentsJson: {
          path: "src/App.tsx",
          content: "export default function App() {}",
          expectedRevision: 1,
        },
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: AGENT_ERROR_CODES.toolReadRequired },
      });

      const read = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-read",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      });
      expect(read.ok).toBe(true);

      const updated = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-write",
        toolName: "write_file",
        argumentsJson: {
          path: "src/App.tsx",
          content: "export default function App() {}",
          expectedRevision: 1,
        },
      });
      expect(updated).toMatchObject({
        ok: true,
        revision: 2,
        data: { operation: "update" },
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("allows a new file without a prior read and replays duplicate calls", async () => {
    const fixture = await createFixture();

    try {
      const input = {
        run: fixture.run,
        toolCallId: "call-create",
        toolName: "write_file",
        argumentsJson: {
          path: "src/New.tsx",
          content: "export const New = true",
          expectedRevision: 1,
        },
      };
      const first = await fixture.executor.execute(input);
      const replay = await fixture.executor.execute(input);

      expect(first).toMatchObject({
        ok: true,
        revision: 2,
        data: { operation: "create" },
      });
      expect(replay).toEqual(first);
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("checks the cancellation fence before a mutation", async () => {
    const fixture = await createFixture();

    try {
      await fixture.store.requestCancellation({
        ownerId: fixture.run.ownerId,
        runId: fixture.run.id,
      });
      const result = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-cancelled",
        toolName: "write_file",
        argumentsJson: {
          path: "src/New.tsx",
          content: "export const New = true",
          expectedRevision: 1,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: AGENT_ERROR_CODES.cancelled },
      });
    } finally {
      await fixture.testDatabase.close();
    }
  });

  it("keeps the winning repository content after a stale mutation", async () => {
    const fixture = await createFixture();

    try {
      const read = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-read-before-conflict",
        toolName: "read_file",
        argumentsJson: { path: "src/App.tsx" },
      });
      expect(read.ok).toBe(true);

      const winningMutation = await fixture.repository.writeFile({
        ownerId: fixture.run.ownerId,
        projectId: fixture.run.projectId,
        path: "src/App.tsx",
        content: "export const winner = true",
        expectedRevision: 1,
      });
      expect(winningMutation.revision).toBe(2);

      const staleMutation = await fixture.executor.execute({
        run: fixture.run,
        toolCallId: "call-stale-write",
        toolName: "write_file",
        argumentsJson: {
          path: "src/App.tsx",
          content: "export const loser = true",
          expectedRevision: 1,
        },
      });
      const file = await fixture.repository.readFile({
        ownerId: fixture.run.ownerId,
        projectId: fixture.run.projectId,
        path: "src/App.tsx",
      });

      expect(staleMutation).toMatchObject({
        ok: false,
        conflict: true,
        error: { code: AGENT_ERROR_CODES.revisionConflict },
      });
      expect(file.content).toBe("export const winner = true");
    } finally {
      await fixture.testDatabase.close();
    }
  });
});
