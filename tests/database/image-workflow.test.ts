import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 数据库测试在 Node 环境直接加载 server-only 领域模块；这里屏蔽 Next
// 的构建期标记，实际数据库与服务端实现仍然保持不变。
vi.mock("server-only", () => ({}));

type TestDatabase = {
  transaction<T>(
    operation: (transaction: TestDatabase) => Promise<T>,
  ): Promise<T>;
};

const databaseRef = vi.hoisted(() => ({
  current: null as TestDatabase | null,
}));

// Worker 依赖的生产数据库客户端连接 Neon。测试把它替换成当前 PGlite
// 实例，只改变数据库出口，不改变领域层的事务与锁逻辑。
vi.mock("@/infrastructure/db/client", () => ({
  getDatabase: () => {
    if (!databaseRef.current) {
      throw new Error("测试数据库尚未初始化。");
    }
    return databaseRef.current;
  },
  runDatabaseTransaction: async <T>(
    operation: (transaction: TestDatabase) => Promise<T>,
  ) => {
    if (!databaseRef.current) {
      throw new Error("测试数据库尚未初始化。");
    }
    return databaseRef.current.transaction(operation);
  },
}));

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import { AgentStore } from "@/domains/agent/store";
import { createFrozenAgentProfile } from "@/domains/agent/profiles";
import type { ImageProvider } from "@/domains/image/generation";
import {
  claimImageJob,
  getImageJob,
  markImageJobFailure,
  markImageJobSucceeded,
} from "@/domains/image/job-store";
import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";
import { processNextImageJob } from "@/domains/image/worker";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import {
  imageJobs,
  projectAssets,
  projects,
  toolInvocations,
} from "@/infrastructure/db/schema";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

const OWNER_ID = "image-workflow-owner";
const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

const imageArguments = {
  prompt: "一张极简的蓝色建筑海报",
  count: 1,
  size: "1024x1024" as const,
};

type ImageFixture = Awaited<ReturnType<typeof createImageFixture>>;

async function createImageFixture() {
  const testDatabase = await createTestDatabase();
  databaseRef.current = testDatabase.database as unknown as TestDatabase;

  const repository = new DatabaseProjectRepository(testDatabase.database);
  const project = await repository.createProject({
    ownerId: OWNER_ID,
    name: "Image workflow",
    initialFiles: [],
  });
  const store = new AgentStore(testDatabase.database);
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
    maxModelTurns: 6,
    maxWallTimeSeconds: 300,
  });
  const parentRun = await store.createRun({
    ownerId: OWNER_ID,
    projectId: project.id,
    conversationTitle: "图片异步工作流",
    userMessage: "生成一张图片",
    profile,
    startRevision: project.revision,
  });
  await store.transitionRun({
    ownerId: OWNER_ID,
    runId: parentRun.id,
    status: "running",
  });
  const leaseId = await store.claimExecution({
    ownerId: OWNER_ID,
    runId: parentRun.id,
  });
  if (!leaseId) {
    throw new Error("测试无法领取 Agent Run 执行租约。");
  }

  const suspended = await store.suspendForImageGeneration({
    ownerId: OWNER_ID,
    runId: parentRun.id,
    projectId: project.id,
    toolCallId: "call-image-1",
    conversationId: parentRun.conversationId,
    argumentsJson: imageArguments,
    idempotencyKey: `${parentRun.id}:call-image-1`,
    revision: project.revision,
    leaseId,
    provider: "openai-compatible",
    model: "fake-image-model",
    profile: "test-image-profile",
    profileVersion: "test-image-profile-v1",
  });
  const job = await getImageJob({ imageJobId: suspended.imageJobId });
  if (!job) {
    throw new Error("测试图片任务尚未创建。");
  }

  return {
    testDatabase,
    repository,
    store,
    project,
    parentRun,
    imageRunId: suspended.imageRunId,
    imageJobId: suspended.imageJobId,
    job,
  };
}

async function closeFixture(fixture: ImageFixture) {
  databaseRef.current = null;
  await fixture.testDatabase.close();
}

function createBlobStore() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(pathname: string, body: Uint8Array | string) {
      objects.set(pathname, typeof body === "string" ? new TextEncoder().encode(body) : body);
      return {
        pathname,
        url: `blob://test/${pathname}`,
      };
    },
    async get() {
      return null;
    },
    async del(pathname: string) {
      objects.delete(pathname);
    },
  };
}

function createSuccessfulProvider(): ImageProvider {
  return {
    async generate() {
      return {
        images: [
          {
            bytes: PNG_1X1,
            mimeType: "image/png",
            providerImageId: "provider-image-1",
          },
        ],
        providerJobId: "provider-job-1",
      };
    },
  };
}

describe("image job store", () => {
  beforeEach(() => {
    databaseRef.current = null;
  });

  it("只允许一个执行器领取 queued job，租约过期后才允许接管", async () => {
    const fixture = await createImageFixture();
    try {
      const now = new Date("2026-08-02T00:00:00.000Z");
      const first = await claimImageJob({
        expectedJobId: fixture.imageJobId,
        now,
      });
      const duplicate = await claimImageJob({
        expectedJobId: fixture.imageJobId,
        now: new Date(now.getTime() + 1_000),
      });
      const takeover = await claimImageJob({
        expectedJobId: fixture.imageJobId,
        now: new Date(now.getTime() + 120_001),
      });

      expect(first?.job.leaseId).toBeTruthy();
      expect(duplicate).toBeNull();
      expect(takeover?.job.leaseId).toBeTruthy();
      expect(takeover?.job.leaseId).not.toBe(first?.job.leaseId);
      expect(takeover?.job.attempt).toBe(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("旧租约不能提交成功结果，重试只在 nextAttemptAt 到期后再次领取", async () => {
    const fixture = await createImageFixture();
    try {
      const first = await claimImageJob({
        expectedJobId: fixture.imageJobId,
      });
      if (!first?.job.leaseId) {
        throw new Error("测试任务未领取。");
      }

      const retry = await markImageJobFailure({
        imageJobId: fixture.imageJobId,
        leaseId: first.job.leaseId,
        errorCode: IMAGE_ERROR_CODES.generationTimeout,
        errorMessage: "Provider 超时",
        retryable: true,
      });
      expect(retry.retryScheduled).toBe(true);

      const retryable = await getImageJob({ imageJobId: fixture.imageJobId });
      expect(retryable?.job.status).toBe("retryable");
      expect(retryable?.job.nextAttemptAt).toBeInstanceOf(Date);

      await expect(
        markImageJobSucceeded({
          imageJobId: fixture.imageJobId,
          leaseId: first.job.leaseId,
        }),
      ).rejects.toMatchObject({
        code: IMAGE_ERROR_CODES.generationJobNotFound,
      });

      const beforeDue = await claimImageJob({
        expectedJobId: fixture.imageJobId,
        now: new Date((retryable?.job.nextAttemptAt?.getTime() ?? 0) - 1),
      });
      expect(beforeDue).toBeNull();

      const afterDue = await claimImageJob({
        expectedJobId: fixture.imageJobId,
        now: new Date((retryable?.job.nextAttemptAt?.getTime() ?? 0) + 1),
      });
      expect(afterDue?.job.attempt).toBe(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("达到最大尝试次数后关闭 job 和 image run，不再继续排队", async () => {
    const fixture = await createImageFixture();
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const claimed = await claimImageJob({
          expectedJobId: fixture.imageJobId,
          now: new Date(Date.now() + attempt * 180_000),
        });
        if (!claimed?.job.leaseId) {
          throw new Error(`第 ${attempt + 1} 次未领取图片任务。`);
        }

        const result = await markImageJobFailure({
          imageJobId: fixture.imageJobId,
          leaseId: claimed.job.leaseId,
          errorCode: IMAGE_ERROR_CODES.generationFailed,
          errorMessage: "Provider 失败",
          retryable: true,
        });
        expect(result.retryScheduled).toBe(attempt < 2);

        if (attempt < 2) {
          await fixture.testDatabase.database
            .update(imageJobs)
            .set({ nextAttemptAt: new Date(0) })
            .where(eq(imageJobs.id, fixture.imageJobId));
        }
      }

      const finalJob = await getImageJob({ imageJobId: fixture.imageJobId });
      expect(finalJob?.job.status).toBe("failed");
      expect(finalJob?.run.status).toBe("failed");
    } finally {
      await closeFixture(fixture);
    }
  });

  it("相同生图请求返回原任务，参数变化则拒绝重复 Tool Call", async () => {
    const fixture = await createImageFixture();
    try {
      const original = await fixture.store.suspendForImageGeneration({
        ownerId: OWNER_ID,
        runId: fixture.parentRun.id,
        projectId: fixture.project.id,
        toolCallId: "call-image-1",
        conversationId: fixture.parentRun.conversationId,
        argumentsJson: imageArguments,
        idempotencyKey: `${fixture.parentRun.id}:call-image-1`,
        revision: fixture.project.revision,
        leaseId: "unused-after-suspend",
        provider: "openai-compatible",
        model: "fake-image-model",
        profile: "test-image-profile",
        profileVersion: "test-image-profile-v1",
      });
      expect(original).toEqual({
        imageRunId: fixture.imageRunId,
        imageJobId: fixture.imageJobId,
      });

      await expect(
        fixture.store.suspendForImageGeneration({
          ownerId: OWNER_ID,
          runId: fixture.parentRun.id,
          projectId: fixture.project.id,
          toolCallId: "call-image-1",
          conversationId: fixture.parentRun.conversationId,
          argumentsJson: { ...imageArguments, count: 2 },
          idempotencyKey: `${fixture.parentRun.id}:call-image-1`,
          revision: fixture.project.revision,
          leaseId: "unused-after-suspend",
          provider: "openai-compatible",
          model: "fake-image-model",
          profile: "test-image-profile",
          profileVersion: "test-image-profile-v1",
        }),
      ).rejects.toMatchObject({
        code: AGENT_ERROR_CODES.toolAlreadyExecuted,
      });
    } finally {
      await closeFixture(fixture);
    }
  });
});

describe("image worker", () => {
  it("成功生成图片并创建项目资产，然后恢复父 Agent Run", async () => {
    const fixture = await createImageFixture();
    const blobStore = createBlobStore();
    const launchAgentRun = vi.fn(async () => undefined);
    try {
      await processNextImageJob({
        expectedJobId: fixture.imageJobId,
        dependencies: {
          provider: createSuccessfulProvider(),
          blobStore,
          agentStore: fixture.store,
          launchAgentRun,
        },
      });

      const [asset] = await fixture.testDatabase.database
        .select()
        .from(projectAssets)
        .where(eq(projectAssets.imageRunId, fixture.imageRunId));
      const completedJob = await getImageJob({
        imageJobId: fixture.imageJobId,
      });
      const parent = await fixture.store.getRun({
        ownerId: OWNER_ID,
        runId: fixture.parentRun.id,
      });

      expect(asset).toMatchObject({
        kind: "generated_image",
        source: "image_generation",
        generationIndex: 0,
        mimeType: "image/png",
      });
      expect(blobStore.objects.size).toBe(1);
      expect(completedJob?.job.status).toBe("succeeded");
      expect(completedJob?.run.status).toBe("succeeded");
      expect(parent.status).toBe("running");
      expect(launchAgentRun).toHaveBeenCalledWith({
        ownerId: OWNER_ID,
        runId: fixture.parentRun.id,
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("Provider 可重试失败时保留 queued 事实并抛回错误", async () => {
    const fixture = await createImageFixture();
    const provider: ImageProvider = {
      async generate() {
        throw new ImageError(
          IMAGE_ERROR_CODES.generationTimeout,
          "Provider 超时",
          504,
        );
      },
    };
    const blobStore = createBlobStore();
    try {
      await expect(
        processNextImageJob({
          expectedJobId: fixture.imageJobId,
          dependencies: {
            provider,
            blobStore,
            agentStore: fixture.store,
            launchAgentRun: vi.fn(async () => undefined),
          },
        }),
      ).rejects.toMatchObject({
        code: IMAGE_ERROR_CODES.generationTimeout,
      });

      const job = await getImageJob({ imageJobId: fixture.imageJobId });
      expect(job?.job.status).toBe("retryable");
      expect(job?.run.status).toBe("running");
      expect(blobStore.objects.size).toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("父 Agent 已取消时接受迟到图片结果，但不恢复 Run 或制造代码 revision", async () => {
    const fixture = await createImageFixture();
    const blobStore = createBlobStore();
    const launchAgentRun = vi.fn(async () => undefined);
    try {
      await fixture.store.requestCancellation({
        ownerId: OWNER_ID,
        runId: fixture.parentRun.id,
      });
      await fixture.store.transitionRun({
        ownerId: OWNER_ID,
        runId: fixture.parentRun.id,
        status: "cancelled",
      });

      await processNextImageJob({
        expectedJobId: fixture.imageJobId,
        dependencies: {
          provider: createSuccessfulProvider(),
          blobStore,
          agentStore: fixture.store,
          launchAgentRun,
        },
      });

      const parent = await fixture.store.getRun({
        ownerId: OWNER_ID,
        runId: fixture.parentRun.id,
      });
      const [project] = await fixture.testDatabase.database
        .select({ revision: projects.revision })
        .from(projects)
        .where(
          and(eq(projects.id, fixture.project.id), eq(projects.ownerId, OWNER_ID)),
        );
      const [invocation] = await fixture.testDatabase.database
        .select({ status: toolInvocations.status })
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.runId, fixture.parentRun.id),
            eq(toolInvocations.toolCallId, "call-image-1"),
          ),
        );

      expect(parent.status).toBe("cancelled");
      expect(parent.currentRevision).toBe(fixture.project.revision);
      expect(project?.revision).toBe(fixture.project.revision);
      expect(invocation?.status).toBe("cancelled");
      expect(launchAgentRun).not.toHaveBeenCalled();
    } finally {
      await closeFixture(fixture);
    }
  });
});
