"use client";

import type {
  BrowserGitMigrationPreparation,
  ProjectDescription,
} from "@/domains/project/types";
import {
  getBrowserGitClient,
  type BrowserGitClient,
} from "@/infrastructure/browser-git/client";
import { browserApiFetch } from "@/infrastructure/http/browser-api";

export type BrowserGitMigrationStage =
  | "preparing"
  | "creating_candidate"
  | "validating_candidate"
  | "promoting"
  | "finalizing"
  | "recovering"
  | "completed";

type Fetcher = typeof fetch;

type MigrationProof = {
  preparation: BrowserGitMigrationPreparation;
  head: string;
};

type MigrationApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
  };
};

/**
 * finalize 请求有一个特殊风险：浏览器可能已经完成正式仓库复制，但响应在
 * 网络层丢失。此时不能把“没收到成功响应”误判成“服务端一定没切换”，更不能
 * 直接删除正式仓库。该错误表示 Controller 已保留 proof，可在网络恢复后重试。
 */
export class BrowserGitMigrationRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserGitMigrationRecoveryRequiredError";
  }
}

export class BrowserGitMigrationController {
  private proof: MigrationProof | null = null;

  constructor(
    private readonly client: Pick<
      BrowserGitClient,
      | "initializeMigrationCandidate"
      | "validateMigrationCandidate"
      | "promoteMigrationCandidate"
      | "deleteRepository"
    >,
    private readonly fetcher: Fetcher,
  ) {}

  get canRecover() {
    return this.proof !== null;
  }

  async migrate(input: {
    project: ProjectDescription;
    onStage?: (stage: BrowserGitMigrationStage) => void;
  }): Promise<ProjectDescription> {
    if (input.project.storageKind !== "database") {
      return input.project;
    }

    input.onStage?.("preparing");
    const preparation = await this.prepare(input.project.id);
    let candidateCreated = false;
    let promoted = false;

    try {
      input.onStage?.("creating_candidate");
      // 初始化过程可能已经创建 IndexedDB 后才因写文件或 commit 失败。
      // 提前标记后，finally 会用独立 candidate ID 做 best-effort 清理。
      candidateCreated = true;
      const candidate = await this.client.initializeMigrationCandidate(
        preparation.candidateRepositoryId,
        {
          projectName: preparation.projectName,
          sourceRevision: preparation.sourceRevision,
          manifestHash: preparation.manifestHash,
          initialFiles: preparation.files,
        },
      );
      input.onStage?.("validating_candidate");
      const validated = await this.client.validateMigrationCandidate(
        preparation.candidateRepositoryId,
        {
          sourceRevision: preparation.sourceRevision,
          manifestHash: preparation.manifestHash,
        },
      );

      if (validated.head !== candidate.head) {
        throw new Error("迁移 candidate 的 HEAD 在校验期间发生变化。");
      }

      input.onStage?.("promoting");
      const formalRepository = await this.client.promoteMigrationCandidate(
        preparation.candidateRepositoryId,
        {
          targetProjectId: input.project.id,
          projectName: preparation.projectName,
          sourceRevision: preparation.sourceRevision,
          manifestHash: preparation.manifestHash,
          head: validated.head,
        },
      );
      promoted = true;
      this.proof = {
        preparation,
        head: formalRepository.head,
      };

      const project = await this.finalizeWithRecovery(
        input.project.id,
        input.onStage,
      );
      input.onStage?.("completed");
      return project;
    } catch (error) {
      // 只有确认服务端仍是 Database 时 finalizeWithRecovery 才会清理正式仓库。
      // 状态未知时 proof 会保留，用户可重试 finalize，不能重新开始一套迁移。
      if (!promoted && !this.proof) {
        await this.cancel(preparation);
      }
      throw error;
    } finally {
      if (candidateCreated) {
        await this.deleteRepositoryBestEffort(
          preparation.candidateRepositoryId,
        );
      }
    }
  }

  async recover(input: {
    projectId: string;
    onStage?: (stage: BrowserGitMigrationStage) => void;
  }) {
    if (!this.proof || this.proof.preparation.projectId !== input.projectId) {
      throw new Error("当前没有可恢复的 Browser Git 迁移。");
    }

    const project = await this.finalizeWithRecovery(
      input.projectId,
      input.onStage,
    );
    input.onStage?.("completed");
    return project;
  }

  private async prepare(projectId: string) {
    const response = await this.fetcher(
      `/api/projects/${projectId}/browser-git/migration`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "prepare" }),
      },
    );
    const body = await readApiBody<{
      migration: BrowserGitMigrationPreparation;
    }>(response);
    return body.migration;
  }

  private async finalizeWithRecovery(
    projectId: string,
    onStage?: (stage: BrowserGitMigrationStage) => void,
  ): Promise<ProjectDescription> {
    const proof = this.proof;

    if (!proof) {
      throw new Error("Browser Git 迁移 proof 不存在。");
    }

    onStage?.("finalizing");
    let finalizeError: unknown;

    // 第一次响应可能只是在网络层丢失；同一 session、token 和 HEAD 的 finalize
    // 是幂等操作，因此立即重试一次不会产生第二次存储切换。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const project = await this.finalize(projectId, proof);
        this.proof = null;
        return project;
      } catch (error) {
        finalizeError = error;
      }
    }

    onStage?.("recovering");
    let currentProject: ProjectDescription;
    try {
      currentProject = await this.describeProject(projectId);
    } catch {
      throw new BrowserGitMigrationRecoveryRequiredError(
        "无法确认服务端是否已经完成切换。正式 Browser Git 仓库已保留，请恢复网络后重试确认。",
      );
    }

    if (currentProject.storageKind === "browser_git") {
      this.proof = null;
      return currentProject;
    }

    // 只有 GET 明确证明服务端仍是 Database，才允许删除已经 promote 的正式仓库。
    // 原 Database 文件与 revision 此时仍是事实来源，清理本地副本后可安全重试。
    await this.deleteRepositoryBestEffort(projectId);
    await this.cancel(proof.preparation);
    this.proof = null;
    throw finalizeError instanceof Error
      ? finalizeError
      : new Error("Database 到 Browser Git 迁移未完成。");
  }

  private async finalize(projectId: string, proof: MigrationProof) {
    const response = await this.fetcher(
      `/api/projects/${projectId}/browser-git/migration`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "finalize",
          sessionId: proof.preparation.sessionId,
          token: proof.preparation.token,
          candidateRepositoryId: proof.preparation.candidateRepositoryId,
          manifestHash: proof.preparation.manifestHash,
          head: proof.head,
        }),
      },
    );
    const body = await readApiBody<{ project: ProjectDescription }>(response);
    return body.project;
  }

  private async describeProject(projectId: string) {
    const response = await this.fetcher(`/api/projects/${projectId}`, {
      cache: "no-store",
    });
    const body = await readApiBody<{ project: ProjectDescription }>(response);
    return body.project;
  }

  private async cancel(preparation: BrowserGitMigrationPreparation) {
    try {
      await this.fetcher(
        `/api/projects/${preparation.projectId}/browser-git/migration`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            sessionId: preparation.sessionId,
            token: preparation.token,
          }),
        },
      );
    } catch {
      // cancel 只回收短期迁移会话。它失败不影响 Database Repository 可用性，
      // 会话仍会在 TTL 到期后失效，因此不能覆盖原始迁移错误。
    }
  }

  private async deleteRepositoryBestEffort(repositoryId: string) {
    try {
      await this.client.deleteRepository(repositoryId);
    } catch {
      // 清理失败不能掩盖迁移结果。candidate 使用独立 ID；正式仓库只会在服务端
      // 已确认仍为 Database 时进入这里，后续重试仍会执行严格 HEAD 校验。
    }
  }
}

export function createBrowserGitMigrationController() {
  return new BrowserGitMigrationController(
    getBrowserGitClient(),
    browserApiFetch,
  );
}

async function readApiBody<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as
    T | MigrationApiErrorBody;

  if (!response.ok) {
    const errorBody = body as MigrationApiErrorBody;
    throw new Error(
      errorBody.error?.message ??
        `Browser Git 迁移请求失败（HTTP ${response.status}）。`,
    );
  }

  return body as T;
}
