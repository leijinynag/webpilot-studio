import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_CODES } from "@/domains/project/errors";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import { browserGitMigrationSessions } from "@/infrastructure/db/schema";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

describe("Database -> Browser Git migration", () => {
  it("prepares a stable sorted snapshot without changing project storage", async () => {
    const fixture = await createFixture();

    try {
      const preparation = await fixture.repository.prepareBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
      });
      const described = await fixture.repository.describe({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
      });

      expect(preparation).toMatchObject({
        projectId: fixture.project.id,
        projectName: fixture.project.name,
        sourceRevision: fixture.project.revision,
        candidateRepositoryId: expect.stringMatching(/^migration-/),
        manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        files: [
          { path: "README.md", content: "# Migration\n" },
          { path: "src/index.ts", content: "export const ready = true;\n" },
        ],
      });
      expect(preparation.token).not.toHaveLength(64);
      expect(described).toMatchObject({
        storageKind: "database",
        status: "ready",
        revision: fixture.project.revision,
      });
    } finally {
      await fixture.close();
    }
  });

  it("atomically switches storage and rejects Database file access afterwards", async () => {
    const fixture = await createFixture();

    try {
      const preparation = await fixture.repository.prepareBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
      });
      const result = await fixture.repository.finalizeBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
        sessionId: preparation.sessionId,
        token: preparation.token,
        candidateRepositoryId: preparation.candidateRepositoryId,
        manifestHash: preparation.manifestHash,
        head: "a".repeat(40),
      });
      const duplicate = await fixture.repository.finalizeBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
        sessionId: preparation.sessionId,
        token: preparation.token,
        candidateRepositoryId: preparation.candidateRepositoryId,
        manifestHash: preparation.manifestHash,
        head: "a".repeat(40),
      });

      expect(result).toMatchObject({
        alreadyCompleted: false,
        project: {
          storageKind: "browser_git",
          status: "ready",
          revision: fixture.project.revision,
        },
      });
      expect(duplicate).toMatchObject({
        alreadyCompleted: true,
        project: { storageKind: "browser_git" },
      });
      await expect(
        fixture.repository.listFiles({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.storageUnavailable,
      });
      await expect(
        fixture.repository.writeFile({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
          path: "README.md",
          content: "must not write",
          expectedRevision: fixture.project.revision,
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.storageUnavailable,
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps the Database repository usable when source revision changes", async () => {
    const fixture = await createFixture();

    try {
      const preparation = await fixture.repository.prepareBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
      });
      const mutation = await fixture.repository.writeFile({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
        path: "README.md",
        content: "# Changed during migration\n",
        expectedRevision: fixture.project.revision,
      });

      await expect(
        fixture.repository.finalizeBrowserGitMigration({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
          sessionId: preparation.sessionId,
          token: preparation.token,
          candidateRepositoryId: preparation.candidateRepositoryId,
          manifestHash: preparation.manifestHash,
          head: "b".repeat(40),
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.revisionConflict,
        details: {
          actualRevision: mutation.revision,
          expectedRevision: preparation.sourceRevision,
        },
      });

      await expect(
        fixture.repository.readFile({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
          path: "README.md",
        }),
      ).resolves.toMatchObject({
        content: "# Changed during migration\n",
      });
      await expect(
        fixture.repository.describe({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
        }),
      ).resolves.toMatchObject({
        storageKind: "database",
        revision: mutation.revision,
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects mismatched, foreign, cancelled and expired migration sessions", async () => {
    const fixture = await createFixture();

    try {
      const preparation = await fixture.repository.prepareBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
      });
      const proof = {
        projectId: fixture.project.id,
        sessionId: preparation.sessionId,
        token: preparation.token,
        candidateRepositoryId: preparation.candidateRepositoryId,
        manifestHash: preparation.manifestHash,
        head: "c".repeat(40),
      };

      await expect(
        fixture.repository.finalizeBrowserGitMigration({
          ...proof,
          ownerId: fixture.ownerId,
          manifestHash: "0".repeat(64),
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.migrationConflict,
      });
      await expect(
        fixture.repository.finalizeBrowserGitMigration({
          ...proof,
          ownerId: "foreign-owner",
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.projectNotFound,
      });

      await fixture.repository.cancelBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
        sessionId: preparation.sessionId,
        token: preparation.token,
      });
      await expect(
        fixture.repository.finalizeBrowserGitMigration({
          ...proof,
          ownerId: fixture.ownerId,
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.migrationConflict,
      });

      const expired = await fixture.repository.prepareBrowserGitMigration({
        ownerId: fixture.ownerId,
        projectId: fixture.project.id,
      });
      await fixture.database
        .update(browserGitMigrationSessions)
        .set({ expiresAt: new Date(0) })
        .where(eq(browserGitMigrationSessions.id, expired.sessionId));
      await expect(
        fixture.repository.finalizeBrowserGitMigration({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
          sessionId: expired.sessionId,
          token: expired.token,
          candidateRepositoryId: expired.candidateRepositoryId,
          manifestHash: expired.manifestHash,
          head: "d".repeat(40),
        }),
      ).rejects.toMatchObject({
        code: PROJECT_ERROR_CODES.migrationExpired,
      });
      await expect(
        fixture.repository.describe({
          ownerId: fixture.ownerId,
          projectId: fixture.project.id,
        }),
      ).resolves.toMatchObject({ storageKind: "database" });
    } finally {
      await fixture.close();
    }
  });
});

async function createFixture() {
  const testDatabase = await createTestDatabase();
  const repository = new DatabaseProjectRepository(testDatabase.database);
  const ownerId = "migration-owner";
  const project = await repository.createProject({
    ownerId,
    name: "Migration project",
    initialFiles: [
      {
        path: "src/index.ts",
        content: "export const ready = true;\n",
      },
      { path: "README.md", content: "# Migration\n" },
    ],
  });

  return {
    ...testDatabase,
    repository,
    ownerId,
    project,
  };
}
