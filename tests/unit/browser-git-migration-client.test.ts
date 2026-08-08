import { describe, expect, it, vi } from "vitest";

import {
  BrowserGitMigrationController,
  BrowserGitMigrationRecoveryRequiredError,
  type BrowserGitMigrationStage,
} from "@/domains/project/browser-git-migration-client";
import type {
  BrowserGitMigrationPreparation,
  ProjectDescription,
} from "@/domains/project/types";
import type { BrowserGitMigrationValidation } from "@/infrastructure/browser-git/protocol";

const project: ProjectDescription = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Migration client",
  storageKind: "database",
  status: "ready",
  revision: 4,
  fileCount: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null,
};

const preparation: BrowserGitMigrationPreparation = {
  sessionId: "22222222-2222-4222-8222-222222222222",
  token: "migration-token-with-enough-entropy",
  projectId: project.id,
  projectName: project.name,
  sourceRevision: project.revision,
  candidateRepositoryId: "migration-33333333-3333-4333-8333-333333333333",
  manifestHash: "a".repeat(64),
  files: [
    {
      path: "README.md",
      content: "# Migration\n",
      hash: "b".repeat(64),
    },
  ],
  expiresAt: "2026-08-01T00:15:00.000Z",
};

const validation: BrowserGitMigrationValidation = {
  repositoryId: preparation.candidateRepositoryId,
  revision: project.revision,
  head: "c".repeat(40),
  branch: "main",
  clean: true,
  manifestHash: preparation.manifestHash,
  fileCount: preparation.files.length,
};

function createClient() {
  return {
    initializeMigrationCandidate: vi.fn().mockResolvedValue(validation),
    validateMigrationCandidate: vi.fn().mockResolvedValue(validation),
    promoteMigrationCandidate: vi.fn().mockResolvedValue({
      ...validation,
      repositoryId: project.id,
    }),
    deleteRepository: vi.fn().mockResolvedValue(undefined),
  };
}

describe("BrowserGitMigrationController", () => {
  it("completes the candidate, promote and finalize protocol in order", async () => {
    const client = createClient();
    const migratedProject = {
      ...project,
      storageKind: "browser_git" as const,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ migration: preparation }))
      .mockResolvedValueOnce(
        Response.json({
          project: migratedProject,
          alreadyCompleted: false,
        }),
      );
    const stages: BrowserGitMigrationStage[] = [];
    const controller = new BrowserGitMigrationController(client, fetcher);

    await expect(
      controller.migrate({
        project,
        onStage: (stage) => stages.push(stage),
      }),
    ).resolves.toEqual(migratedProject);

    expect(stages).toEqual([
      "preparing",
      "creating_candidate",
      "validating_candidate",
      "promoting",
      "finalizing",
      "completed",
    ]);
    expect(client.promoteMigrationCandidate).toHaveBeenCalledWith(
      preparation.candidateRepositoryId,
      expect.objectContaining({
        targetProjectId: project.id,
        head: validation.head,
      }),
    );
    expect(client.deleteRepository).toHaveBeenCalledWith(
      preparation.candidateRepositoryId,
    );
    expect(client.deleteRepository).not.toHaveBeenCalledWith(project.id);
    expect(controller.canRecover).toBe(false);
  });

  it("accepts an idempotent server switch after both finalize responses are lost", async () => {
    const client = createClient();
    const migratedProject = {
      ...project,
      storageKind: "browser_git" as const,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ migration: preparation }))
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockRejectedValueOnce(new TypeError("network still lost"))
      .mockResolvedValueOnce(Response.json({ project: migratedProject }));
    const controller = new BrowserGitMigrationController(client, fetcher);

    await expect(controller.migrate({ project })).resolves.toEqual(
      migratedProject,
    );

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(client.deleteRepository).not.toHaveBeenCalledWith(project.id);
    expect(controller.canRecover).toBe(false);
  });

  it("keeps the formal repository when the server state cannot be confirmed", async () => {
    const client = createClient();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ migration: preparation }))
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockRejectedValueOnce(new TypeError("network still lost"))
      .mockRejectedValueOnce(new TypeError("project query failed"));
    const controller = new BrowserGitMigrationController(client, fetcher);

    await expect(controller.migrate({ project })).rejects.toBeInstanceOf(
      BrowserGitMigrationRecoveryRequiredError,
    );

    expect(client.deleteRepository).not.toHaveBeenCalledWith(project.id);
    expect(controller.canRecover).toBe(true);
  });

  it("cleans the promoted copy only after the server confirms Database is still active", async () => {
    const client = createClient();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ migration: preparation }))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "PROJECT_REVISION_CONFLICT",
              message: "项目 revision 已变化。",
            },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "PROJECT_REVISION_CONFLICT",
              message: "项目 revision 已变化。",
            },
          },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ project }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const controller = new BrowserGitMigrationController(client, fetcher);

    await expect(controller.migrate({ project })).rejects.toThrow(
      "项目 revision 已变化。",
    );

    expect(client.deleteRepository).toHaveBeenCalledWith(project.id);
    expect(client.deleteRepository).toHaveBeenCalledWith(
      preparation.candidateRepositoryId,
    );
    expect(controller.canRecover).toBe(false);
  });

  it("retries the same finalize proof after an unknown-state failure", async () => {
    const client = createClient();
    const migratedProject = {
      ...project,
      storageKind: "browser_git" as const,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ migration: preparation }))
      .mockRejectedValueOnce(new TypeError("network lost"))
      .mockRejectedValueOnce(new TypeError("network still lost"))
      .mockRejectedValueOnce(new TypeError("project query failed"))
      .mockResolvedValueOnce(
        Response.json({
          project: migratedProject,
          alreadyCompleted: true,
        }),
      );
    const controller = new BrowserGitMigrationController(client, fetcher);

    await expect(controller.migrate({ project })).rejects.toBeInstanceOf(
      BrowserGitMigrationRecoveryRequiredError,
    );
    await expect(
      controller.recover({ projectId: project.id }),
    ).resolves.toEqual(migratedProject);

    const finalizeBodies = fetcher.mock.calls
      .map((call) => {
        const body = call[1]?.body;
        return typeof body === "string"
          ? (JSON.parse(body) as { action?: string; head?: string })
          : null;
      })
      .filter((body) => body?.action === "finalize");
    expect(finalizeBodies).toHaveLength(3);
    expect(finalizeBodies.every((body) => body?.head === validation.head)).toBe(
      true,
    );
    expect(client.initializeMigrationCandidate).toHaveBeenCalledOnce();
  });
});
