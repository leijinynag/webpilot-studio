import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import type { ProjectRepository } from "@/domains/project/repository";
import type {
  ProjectCheckpoint,
  ProjectFileMutation,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
  ProjectSearchOptions,
} from "@/domains/project/types";

export type ProjectContentRepository = {
  initialize(
    initialFiles: readonly { path: string; content: string }[],
  ): Promise<{ revision: number; fileCount: number }>;
  getRevision(): Promise<number>;
  listFiles(): Promise<ProjectFileSnapshot[]>;
  readFile(path: string): Promise<ProjectFileSnapshot>;
  searchText(
    query: string,
    options?: ProjectSearchOptions,
  ): Promise<ProjectSearchMatch[]>;
  writeFile(input: {
    path: string;
    content: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  deleteFile(input: {
    path: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  renameFile(input: {
    fromPath: string;
    toPath: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
  batchMutateFiles(input: {
    expectedRevision: number;
    mutations: readonly ProjectFileMutation[];
  }): Promise<ProjectMutationResult>;
  createCheckpoint(input: {
    summary?: string;
    expectedRevision?: number;
  }): Promise<ProjectCheckpoint>;
  restoreCheckpoint(input: {
    checkpointId: string;
    expectedRevision: number;
  }): Promise<ProjectMutationResult>;
};

type ProjectContentFixture = {
  repository: ProjectContentRepository;
  close(): Promise<void>;
};

type ProjectIndexFixture = {
  repository: ProjectRepository;
  close(): Promise<void>;
};

/**
 * 两种存储实现真正共享的是“单个项目内的源码行为”，不是服务端项目列表。
 * 该契约故意不包含 owner、软删除与项目创建 API，避免 Browser Git adapter
 * 为了满足测试而伪装成完整的服务端 ProjectRepository。
 */
export function describeProjectContentRepositoryContract(
  name: string,
  createFixture: () => Promise<ProjectContentFixture>,
) {
  describe(`${name} project content contract`, () => {
    let fixture!: ProjectContentFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture?.close();
    });

    it("starts an empty project at revision 0 and advances the first write", async () => {
      await expect(fixture.repository.initialize([])).resolves.toEqual({
        revision: 0,
        fileCount: 0,
      });
      await expect(fixture.repository.listFiles()).resolves.toEqual([]);

      await expect(
        fixture.repository.writeFile({
          path: "src/App.tsx",
          content: "export default function App() { return null; }",
          expectedRevision: 0,
        }),
      ).resolves.toEqual({
        revision: 1,
        changedPaths: ["src/App.tsx"],
      });
    });

    it("reads, searches, writes, renames and deletes files", async () => {
      await initializeProject(fixture.repository);

      await expect(
        fixture.repository.readFile("src/App.tsx"),
      ).resolves.toMatchObject({ content: "hello world" });
      await expect(fixture.repository.searchText("world")).resolves.toEqual([
        {
          path: "src/App.tsx",
          line: 1,
          column: 7,
          excerpt: "hello world",
        },
      ]);

      await expect(
        fixture.repository.writeFile({
          path: "src/App.tsx",
          content: "hello updated",
          expectedRevision: 1,
        }),
      ).resolves.toEqual({
        revision: 2,
        changedPaths: ["src/App.tsx"],
      });

      await expect(
        fixture.repository.renameFile({
          fromPath: "src/App.tsx",
          toPath: "src/Main.tsx",
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ revision: 3 });

      await expect(
        fixture.repository.deleteFile({
          path: "src/Main.tsx",
          expectedRevision: 3,
        }),
      ).resolves.toMatchObject({ revision: 4 });
      await expect(
        fixture.repository.readFile("src/Main.tsx"),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });
    });

    it("rejects reserved and traversing paths", async () => {
      await initializeProject(fixture.repository);

      await expect(
        fixture.repository.writeFile({
          path: ".git/config",
          content: "forbidden",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.invalidPath });
      await expect(
        fixture.repository.writeFile({
          path: "src/../secret.ts",
          content: "forbidden",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.invalidPath });
    });

    it("uses revision CAS and preserves the winning mutation", async () => {
      await initializeProject(fixture.repository);

      await fixture.repository.writeFile({
        path: "src/App.tsx",
        content: "winner",
        expectedRevision: 1,
      });
      await expect(
        fixture.repository.writeFile({
          path: "src/App.tsx",
          content: "stale overwrite",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.revisionConflict,
        details: { actualRevision: 2, expectedRevision: 1 },
      });
      await expect(
        fixture.repository.readFile("src/App.tsx"),
      ).resolves.toMatchObject({ content: "winner" });
    });

    it("applies a file batch atomically and advances only one revision", async () => {
      await initializeProject(fixture.repository);

      await expect(
        fixture.repository.batchMutateFiles({
          expectedRevision: 1,
          mutations: [
            {
              type: "write",
              path: "src/z-last.ts",
              content: "export const z = true;",
            },
            { type: "delete", path: "src/styles.css" },
            {
              type: "write",
              path: "src/App.tsx",
              content: "batch updated",
            },
          ],
        }),
      ).resolves.toEqual({
        revision: 2,
        changedPaths: ["src/App.tsx", "src/styles.css", "src/z-last.ts"],
      });

      await expect(fixture.repository.getRevision()).resolves.toBe(2);
      await expect(
        fixture.repository.readFile("src/App.tsx"),
      ).resolves.toMatchObject({ content: "batch updated" });
      await expect(
        fixture.repository.readFile("src/z-last.ts"),
      ).resolves.toMatchObject({ content: "export const z = true;" });
      await expect(
        fixture.repository.readFile("src/styles.css"),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });
    });

    it("rejects an invalid batch without leaving partial file changes", async () => {
      await initializeProject(fixture.repository);

      await expect(
        fixture.repository.batchMutateFiles({
          expectedRevision: 1,
          mutations: [
            {
              type: "write",
              path: "src/partial.ts",
              content: "must not survive",
            },
            { type: "delete", path: "src/missing.ts" },
          ],
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });

      await expect(fixture.repository.getRevision()).resolves.toBe(1);
      await expect(
        fixture.repository.readFile("src/partial.ts"),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });
    });

    it("rejects stale and duplicate-path batches before writing", async () => {
      await initializeProject(fixture.repository);

      await fixture.repository.writeFile({
        path: "src/App.tsx",
        content: "revision winner",
        expectedRevision: 1,
      });
      await expect(
        fixture.repository.batchMutateFiles({
          expectedRevision: 1,
          mutations: [
            {
              type: "write",
              path: "src/stale.ts",
              content: "must not survive",
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.revisionConflict,
      });

      await expect(
        fixture.repository.batchMutateFiles({
          expectedRevision: 2,
          mutations: [
            {
              type: "write",
              path: "src/duplicate.ts",
              content: "first",
            },
            { type: "delete", path: "src/duplicate.ts" },
          ],
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.pathConflict });

      await expect(fixture.repository.getRevision()).resolves.toBe(2);
      await expect(
        fixture.repository.readFile("src/stale.ts"),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });
      await expect(
        fixture.repository.readFile("src/duplicate.ts"),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });
    });

    it("rejects rename conflicts without advancing revision", async () => {
      await initializeProject(fixture.repository);

      await expect(
        fixture.repository.renameFile({
          fromPath: "src/App.tsx",
          toPath: "src/styles.css",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.pathConflict });
      await expect(fixture.repository.getRevision()).resolves.toBe(1);
    });

    it("enforces result, excerpt and total-character search budgets", async () => {
      await fixture.repository.initialize([
        { path: "src/a.ts", content: "needle " + "a".repeat(80) },
        { path: "src/b.ts", content: "needle " + "b".repeat(80) },
        { path: "src/c.ts", content: "needle " + "c".repeat(80) },
      ]);

      const matches = await fixture.repository.searchText("needle", {
        maxResults: 3,
        maxExcerptCharacters: 20,
        maxTotalCharacters: 40,
      });

      expect(matches).toHaveLength(2);
      expect(matches.every((match) => match.excerpt.length <= 20)).toBe(true);
      expect(
        matches.reduce((total, match) => total + match.excerpt.length, 0),
      ).toBeLessThanOrEqual(40);
    });

    it("restores a checkpoint into a new revision", async () => {
      await initializeProject(fixture.repository);
      const checkpoint = await fixture.repository.createCheckpoint({
        expectedRevision: 1,
      });

      await fixture.repository.writeFile({
        path: "src/App.tsx",
        content: "changed",
        expectedRevision: 1,
      });
      await expect(
        fixture.repository.restoreCheckpoint({
          checkpointId: checkpoint.id,
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ revision: 3 });
      await expect(
        fixture.repository.readFile("src/App.tsx"),
      ).resolves.toMatchObject({ content: "hello world" });
    });
  });
}

/**
 * 项目索引、匿名 owner 隔离和 Browser Git provision 是服务端职责，
 * 因此只要求 DatabaseProjectRepository 通过这一组契约。
 */
export function describeProjectIndexRepositoryContract(
  createFixture: () => Promise<ProjectIndexFixture>,
) {
  describe("Database project index contract", () => {
    let fixture!: ProjectIndexFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await fixture?.close();
    });

    it("isolates projects by owner", async () => {
      const project = await fixture.repository.createProject({
        ownerId: "owner-a",
        name: "Owner project",
        initialFiles: [],
      });

      await expect(
        fixture.repository.describe({
          ownerId: "owner-b",
          projectId: project.id,
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("soft deletes and restores projects for the same owner", async () => {
      const project = await fixture.repository.createProject({
        ownerId: "owner-a",
        name: "Restorable project",
        initialFiles: [],
      });

      await fixture.repository.deleteProject({
        ownerId: "owner-a",
        projectId: project.id,
      });
      await expect(
        fixture.repository.listProjects({ ownerId: "owner-a" }),
      ).resolves.toEqual([]);
      await expect(
        fixture.repository.listProjects({
          ownerId: "owner-a",
          includeDeleted: true,
        }),
      ).resolves.toMatchObject([{ id: project.id }]);

      await fixture.repository.restoreProject({
        ownerId: "owner-a",
        projectId: project.id,
      });
      await expect(
        fixture.repository.listProjects({ ownerId: "owner-a" }),
      ).resolves.toMatchObject([{ id: project.id }]);
    });

    it("issues a Browser Git provision claim only once", async () => {
      const project = await fixture.repository.createProject({
        ownerId: "owner-a",
        name: "Local project",
        storageKind: "browser_git",
        initialFiles: [
          {
            path: "src/index.tsx",
            content: "export const template = true;",
          },
        ],
      });

      expect(project.status).toBe("creating");
      await expect(
        fixture.repository.claimBrowserGitProvision({
          ownerId: "owner-a",
          projectId: project.id,
        }),
      ).resolves.toEqual({
        allowCreate: true,
        status: "ready",
        initialFiles: [
          {
            path: "src/index.tsx",
            content: "export const template = true;",
          },
        ],
      });
      await expect(
        fixture.repository.claimBrowserGitProvision({
          ownerId: "owner-a",
          projectId: project.id,
        }),
      ).resolves.toEqual({
        allowCreate: false,
        status: "ready",
        initialFiles: [],
      });
    });

    it("marks a lost Browser Git repository unavailable", async () => {
      const project = await fixture.repository.createProject({
        ownerId: "owner-a",
        name: "Lost local project",
        storageKind: "browser_git",
        initialFiles: [],
      });

      await fixture.repository.markBrowserGitUnavailable({
        ownerId: "owner-a",
        projectId: project.id,
      });
      await expect(
        fixture.repository.describe({
          ownerId: "owner-a",
          projectId: project.id,
        }),
      ).resolves.toMatchObject({ status: "unavailable" });
    });
  });
}

async function initializeProject(repository: ProjectContentRepository) {
  return repository.initialize([
    { path: "src/App.tsx", content: "hello world" },
    { path: "src/styles.css", content: "body {}" },
  ]);
}
