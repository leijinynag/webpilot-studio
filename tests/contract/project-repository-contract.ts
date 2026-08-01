import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import type { ProjectRepository } from "@/domains/project/repository";

type ProjectRepositoryFixture = {
  repository: ProjectRepository;
  close(): Promise<void>;
};

/**
 * ProjectRepository 的行为契约不依赖具体存储实现。
 * Database 与后续 Browser Git 只需提供 fixture 工厂，就必须通过同一组业务断言。
 */
export function describeProjectRepositoryContract(
  name: string,
  createFixture: () => Promise<ProjectRepositoryFixture>,
) {
  describe(`${name} ProjectRepository contract`, () => {
    let fixture: ProjectRepositoryFixture;

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      // 即使断言中途失败，也要释放当前测试独占的数据库或浏览器存储。
      await fixture.close();
    });

    it("creates an empty revision 0 project and advances the first write to revision 1", async () => {
      const project = await fixture.repository.createProject({
        ownerId: "owner-a",
        name: "Empty project",
        initialFiles: [],
      });

      expect(project).toMatchObject({ revision: 0, fileCount: 0 });
      await expect(
        fixture.repository.listFiles({
          ownerId: "owner-a",
          projectId: project.id,
        }),
      ).resolves.toEqual([]);

      const firstWrite = await fixture.repository.writeFile({
        ownerId: "owner-a",
        projectId: project.id,
        path: "src/App.tsx",
        content: "export default function App() { return null; }",
        expectedRevision: 0,
      });

      expect(firstWrite).toEqual({
        revision: 1,
        changedPaths: ["src/App.tsx"],
      });
    });

    it("creates, reads, searches, writes, renames and deletes files", async () => {
      const project = await createProject(fixture.repository, "owner-a");

      expect(project.revision).toBe(1);
      expect(project.fileCount).toBe(2);
      await expect(
        fixture.repository.readFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: "src/App.tsx",
        }),
      ).resolves.toMatchObject({ content: "hello world" });

      await expect(
        fixture.repository.searchText({
          ownerId: "owner-a",
          projectId: project.id,
          query: "world",
        }),
      ).resolves.toEqual([
        {
          path: "src/App.tsx",
          line: 1,
          column: 7,
          excerpt: "hello world",
        },
      ]);

      const write = await fixture.repository.writeFile({
        ownerId: "owner-a",
        projectId: project.id,
        path: "src/App.tsx",
        content: "hello updated",
        expectedRevision: 1,
      });
      expect(write).toEqual({ revision: 2, changedPaths: ["src/App.tsx"] });

      const rename = await fixture.repository.renameFile({
        ownerId: "owner-a",
        projectId: project.id,
        fromPath: "src/App.tsx",
        toPath: "src/Main.tsx",
        expectedRevision: 2,
      });
      expect(rename.revision).toBe(3);

      const deletion = await fixture.repository.deleteFile({
        ownerId: "owner-a",
        projectId: project.id,
        path: "src/Main.tsx",
        expectedRevision: 3,
      });
      expect(deletion.revision).toBe(4);
      await expect(
        fixture.repository.readFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: "src/Main.tsx",
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.fileNotFound });
    });

    it("isolates projects by owner and rejects reserved paths", async () => {
      const project = await createProject(fixture.repository, "owner-a");

      await expect(
        fixture.repository.describe({
          ownerId: "owner-b",
          projectId: project.id,
        }),
      ).rejects.toMatchObject({ status: 404 });

      await expect(
        fixture.repository.writeFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: ".git/config",
          content: "forbidden",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.invalidPath });

      await expect(
        fixture.repository.writeFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: "src/../secret.ts",
          content: "forbidden",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.invalidPath });
    });

    it("uses revision CAS and preserves the winning mutation", async () => {
      const project = await createProject(fixture.repository, "owner-a");

      await fixture.repository.writeFile({
        ownerId: "owner-a",
        projectId: project.id,
        path: "src/App.tsx",
        content: "winner",
        expectedRevision: 1,
      });

      await expect(
        fixture.repository.writeFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: "src/App.tsx",
          content: "stale overwrite",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.revisionConflict,
        details: { actualRevision: 2, expectedRevision: 1 },
      });

      await expect(
        fixture.repository.readFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: "src/App.tsx",
        }),
      ).resolves.toMatchObject({ content: "winner" });
    });

    it("rejects rename conflicts without advancing revision", async () => {
      const project = await createProject(fixture.repository, "owner-a");

      await expect(
        fixture.repository.renameFile({
          ownerId: "owner-a",
          projectId: project.id,
          fromPath: "src/App.tsx",
          toPath: "src/styles.css",
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: PROJECT_ERROR_CODES.pathConflict });

      await expect(
        fixture.repository.describe({
          ownerId: "owner-a",
          projectId: project.id,
        }),
      ).resolves.toMatchObject({ revision: 1 });
    });

    it("enforces result, excerpt and total-character search budgets", async () => {
      const project = await fixture.repository.createProject({
        ownerId: "owner-a",
        name: "Search limits",
        initialFiles: [
          {
            path: "src/a.ts",
            content: "needle " + "a".repeat(80),
          },
          {
            path: "src/b.ts",
            content: "needle " + "b".repeat(80),
          },
          {
            path: "src/c.ts",
            content: "needle " + "c".repeat(80),
          },
        ],
      });

      const matches = await fixture.repository.searchText({
        ownerId: "owner-a",
        projectId: project.id,
        query: "needle",
        options: {
          maxResults: 3,
          maxExcerptCharacters: 20,
          maxTotalCharacters: 40,
        },
      });

      expect(matches).toHaveLength(2);
      expect(matches.every((match) => match.excerpt.length <= 20)).toBe(true);
      expect(
        matches.reduce((total, match) => total + match.excerpt.length, 0),
      ).toBeLessThanOrEqual(40);
    });

    it("soft deletes and restores projects for the same owner", async () => {
      const project = await createProject(fixture.repository, "owner-a");

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

    it("restores a checkpoint into a new revision", async () => {
      const project = await createProject(fixture.repository, "owner-a");
      const checkpoint = await fixture.repository.createCheckpoint({
        ownerId: "owner-a",
        projectId: project.id,
        expectedRevision: 1,
      });

      await fixture.repository.writeFile({
        ownerId: "owner-a",
        projectId: project.id,
        path: "src/App.tsx",
        content: "changed",
        expectedRevision: 1,
      });
      const restored = await fixture.repository.restoreCheckpoint({
        ownerId: "owner-a",
        projectId: project.id,
        checkpointId: checkpoint.id,
        expectedRevision: 2,
      });

      expect(restored.revision).toBe(3);
      await expect(
        fixture.repository.readFile({
          ownerId: "owner-a",
          projectId: project.id,
          path: "src/App.tsx",
        }),
      ).resolves.toMatchObject({ content: "hello world" });
    });
  });
}

async function createProject(repository: ProjectRepository, ownerId: string) {
  return repository.createProject({
    ownerId,
    name: "Test project",
    initialFiles: [
      { path: "src/App.tsx", content: "hello world" },
      { path: "src/styles.css", content: "body {}" },
    ],
  });
}
