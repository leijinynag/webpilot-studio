import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const environment = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

type TestDatabase = {
  transaction<T>(
    operation: (transaction: TestDatabase) => Promise<T>,
  ): Promise<T>;
};

const databaseRef = vi.hoisted(() => ({
  current: null as TestDatabase | null,
}));

vi.mock("@/infrastructure/env/server", () => ({
  // 预算服务只读取 serverEnv，不在测试中重新解析 process.env。
  // 通过共享对象切换配置，可以覆盖预算启用、关闭和价格缺失三种部署状态。
  serverEnv: environment.current,
}));

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

import { QUOTA_ERROR_CODES } from "@/infrastructure/quota/errors";
import {
  dailyBudgetBuckets,
  imageRuns,
  usageLedger,
} from "@/infrastructure/db/schema";
import { AgentStore } from "@/domains/agent/store";
import { createFrozenAgentProfile } from "@/domains/agent/profiles";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import {
  assertGlobalBudgetAvailable,
  isGlobalBudgetEnabled,
  reserveContextCheckpointUsageBudget,
  reserveImageUsageBudget,
  reserveModelUsageBudget,
  settleContextCheckpointUsageBudget,
  settleImageUsageBudget,
  settleModelUsageBudget,
} from "@/infrastructure/quota/service";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

const OWNER_ID = "quota-budget-owner";

const emptyEnvironment = () => {
  for (const key of Object.keys(environment.current)) {
    delete environment.current[key];
  }
};

function enableBudget(overrides: Record<string, unknown> = {}) {
  Object.assign(environment.current, {
    MAX_GLOBAL_DAILY_COST_USD: 0.0003,
    LLM_INPUT_COST_PER_1M_USD: 1,
    LLM_OUTPUT_COST_PER_1M_USD: 2,
    VISION_INPUT_COST_PER_1M_USD: 1,
    VISION_OUTPUT_COST_PER_1M_USD: 2,
    IMAGE_COST_PER_GENERATION_USD: 0.0001,
    ...overrides,
  });
}

function utcDateKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 费用账本的外键故意保持严格：预算测试不能用随机 UUID 冒充
 * agent_runs/image_runs，否则测到的只是数据库拒绝脏数据。
 *
 * 这里创建最小合法领域 fixture，让测试继续聚焦预算服务本身，同时复用
 * 生产项目创建和 Agent Run 创建路径，避免把 schema 必填字段复制到测试里。
 */
async function createAgentRunRecordFixture(
  database: ConstructorParameters<typeof DatabaseProjectRepository>[0],
  input?: {
    conversationId?: string;
    title?: string;
  },
) {
  const repository = new DatabaseProjectRepository(database);
  const project = await repository.createProject({
    ownerId: OWNER_ID,
    name: "Quota budget agent",
    initialFiles: [],
  });
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
    maxModelTurns: 4,
    maxWallTimeSeconds: 60,
  });
  const store = new AgentStore(database);
  const run = await store.createRun({
    ownerId: OWNER_ID,
    projectId: project.id,
    conversationId: input?.conversationId,
    conversationTitle: input?.title ?? "预算测试",
    userMessage: "预算测试消息",
    profile,
    startRevision: project.revision,
  });

  return run;
}

async function createAgentRunFixture(
  database: ConstructorParameters<typeof DatabaseProjectRepository>[0],
) {
  return (await createAgentRunRecordFixture(database)).id;
}

async function createFollowUpAgentRunFixture(
  database: ConstructorParameters<typeof DatabaseProjectRepository>[0],
  firstRun: Awaited<ReturnType<typeof createAgentRunRecordFixture>>,
) {
  const store = new AgentStore(database);
  // 同一项目只允许一个 active Run。测试先让首条夹具进入终态，再在同一
  // Conversation 创建后续 Run，以模拟不同 Serverless 实例争抢同一摘要边界。
  await store.transitionRun({
    ownerId: OWNER_ID,
    runId: firstRun.id,
    status: "failed",
    errorCode: "TEST_FIXTURE_COMPLETED",
    errorMessage: "预算测试释放 active Run 约束。",
  });
  const profile = createFrozenAgentProfile({
    locale: "zh-CN",
    projectId: firstRun.projectId,
    revision: firstRun.currentRevision,
    repositoryCapability: firstRun.repositoryCapability,
    provider: firstRun.provider,
    model: firstRun.model,
    maxModelTurns: null,
    maxWallTimeSeconds: 60,
  });

  return store.createRun({
    ownerId: OWNER_ID,
    projectId: firstRun.projectId,
    conversationId: firstRun.conversationId,
    conversationTitle: "并发摘要预算测试",
    userMessage: "后续 Run",
    profile,
    startRevision: firstRun.currentRevision,
  });
}

async function createImageRunFixture(
  database: ConstructorParameters<typeof DatabaseProjectRepository>[0],
) {
  const repository = new DatabaseProjectRepository(database);
  const project = await repository.createProject({
    ownerId: OWNER_ID,
    name: "Quota budget image",
    initialFiles: [],
  });
  const imageRunId = crypto.randomUUID();

  await database.insert(imageRuns).values({
    id: imageRunId,
    ownerId: OWNER_ID,
    projectId: project.id,
    toolCallId: `quota-image-${imageRunId}`,
    prompt: "预算测试图片",
    requestedCount: 1,
    size: "1024x1024",
    status: "queued",
    provider: "openai-compatible",
    model: "gpt-image-2",
    profile: "test-image-profile",
    profileVersion: "test-image-profile-v1",
    idempotencyKey: `quota-image-run-${imageRunId}`,
  });

  return imageRunId;
}

describe("global usage budget", () => {
  beforeEach(() => {
    emptyEnvironment();
  });

  it("未配置全局预算时保持旧流程兼容", async () => {
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      expect(isGlobalBudgetEnabled()).toBe(false);
      await expect(assertGlobalBudgetAvailable()).resolves.toBeUndefined();
    } finally {
      await database.close();
    }
  });

  it("模型调用可以预留并按真实 token 用量结算", async () => {
    enableBudget();
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const agentRunId = await createAgentRunFixture(database.database);
      const reservation = await reserveModelUsageBudget({
        ownerId: OWNER_ID,
        agentRunId,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        turn: 1,
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
      });

      if (!reservation) {
        throw new Error("预算开启后模型调用必须创建 reservation。");
      }

      expect(reservation).toMatchObject({
        reservedCostUsd: "0.000300",
      });

      await settleModelUsageBudget({
        reservation,
        provider: "deepseek",
        inputTokens: 50,
        outputTokens: 20,
        providerRequestStarted: true,
        usageObserved: true,
      });
      await settleModelUsageBudget({
        reservation,
        provider: "deepseek",
        inputTokens: 50,
        outputTokens: 20,
        providerRequestStarted: true,
        usageObserved: true,
      });

      const [ledger] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, reservation.idempotencyKey));
      const [bucket] = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));

      expect(ledger).toMatchObject({
        status: "settled",
        inputTokens: 50,
        outputTokens: 20,
        estimatedCostUsd: "0.000090",
      });
      expect(bucket).toMatchObject({
        reservedUsd: "0.000000",
        consumedUsd: "0.000090",
      });
    } finally {
      await database.close();
    }
  });

  it("Checkpoint 在 Provider 前失败时释放 reservation，之后可重新预留", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.01 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const run = await createAgentRunRecordFixture(database.database);
      const input = {
        ownerId: OWNER_ID,
        agentRunId: run.id,
        conversationId: run.conversationId,
        checkpointVersion: 0,
        transcriptSeq: 12,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
      } as const;
      const first = await reserveContextCheckpointUsageBudget(input);
      if (!first) {
        throw new Error("Checkpoint 必须创建预算 reservation。");
      }

      await settleContextCheckpointUsageBudget({
        reservation: first,
        provider: "deepseek",
        inputTokens: 0,
        outputTokens: 0,
        providerRequestStarted: false,
        usageObserved: false,
        latencyMs: 7,
      });
      const retried = await reserveContextCheckpointUsageBudget(input);

      expect(retried).toMatchObject({
        idempotencyKey: first.idempotencyKey,
        alreadySettled: false,
        reservedCostUsd: first.reservedCostUsd,
      });
      const [ledger] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      const [bucket] = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));
      expect(ledger).toMatchObject({
        resource: "context_checkpoint",
        status: "reserved",
      });
      expect(bucket).toMatchObject({
        reservedUsd: first.reservedCostUsd,
        consumedUsd: "0.000000",
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });

  it("Checkpoint 已启动但没有 usage 时按预留上限幂等结算", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.01 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const run = await createAgentRunRecordFixture(database.database);
      const reservation = await reserveContextCheckpointUsageBudget({
        ownerId: OWNER_ID,
        agentRunId: run.id,
        conversationId: run.conversationId,
        checkpointVersion: 2,
        transcriptSeq: 48,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
      });
      if (!reservation) {
        throw new Error("Checkpoint 必须创建预算 reservation。");
      }

      const settlement = {
        reservation,
        provider: "deepseek",
        inputTokens: 0,
        outputTokens: 0,
        providerRequestStarted: true,
        usageObserved: false,
        latencyMs: 321,
      } as const;
      await settleContextCheckpointUsageBudget(settlement);
      await settleContextCheckpointUsageBudget(settlement);

      const [ledger] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, reservation.idempotencyKey));
      const [bucket] = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));
      expect(ledger).toMatchObject({
        resource: "context_checkpoint",
        status: "settled",
        estimatedCostUsd: reservation.reservedCostUsd,
        metadata: expect.objectContaining({
          checkpointVersion: 2,
          transcriptSeq: 48,
          latencyMs: 321,
          usageObserved: false,
          costEstimation: "reserved_upper_bound",
        }),
      });
      expect(bucket).toMatchObject({
        reservedUsd: "0.000000",
        consumedUsd: reservation.reservedCostUsd,
      });

      const replay = await reserveContextCheckpointUsageBudget({
        ownerId: OWNER_ID,
        agentRunId: run.id,
        conversationId: run.conversationId,
        checkpointVersion: 2,
        transcriptSeq: 48,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
      });
      expect(replay).toMatchObject({
        alreadySettled: true,
        reservedCostUsd: "0",
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });

  it("预算开启时同一 Checkpoint 边界只有一个 Run 取得 Claim 并计费", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.02 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const firstRun = await createAgentRunRecordFixture(database.database);
      const secondRun = await createFollowUpAgentRunFixture(
        database.database,
        firstRun,
      );

      const reservations = await Promise.all(
        [firstRun, secondRun].map((run) =>
          reserveContextCheckpointUsageBudget({
            ownerId: OWNER_ID,
            agentRunId: run.id,
            conversationId: firstRun.conversationId,
            checkpointVersion: 3,
            transcriptSeq: 72,
            provider: "deepseek",
            model: "deepseek-v4-flash",
            estimatedInputTokens: 80,
            maxOutputTokens: 120,
          }),
        ),
      );
      if (reservations.some((reservation) => !reservation)) {
        throw new Error("Checkpoint 幂等 Claim 必须返回 reservation 状态。");
      }
      const acquired = reservations.filter(
        (reservation) => reservation?.acquired,
      );
      expect(acquired).toHaveLength(1);
      expect(
        reservations.filter((reservation) => !reservation?.acquired),
      ).toHaveLength(1);

      await settleContextCheckpointUsageBudget({
        reservation: acquired[0]!,
        provider: "deepseek",
        inputTokens: 60,
        outputTokens: 20,
        providerRequestStarted: true,
        usageObserved: true,
        latencyMs: 88,
      });

      const ledgers = await database.database
        .select()
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.resource, "context_checkpoint"),
            eq(usageLedger.ownerId, OWNER_ID),
          ),
        );
      const [bucket] = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0]).toMatchObject({
        status: "settled",
        agentRunId: acquired[0]!.claimId
          ? reservations[0]?.claimId === acquired[0]!.claimId
            ? firstRun.id
            : secondRun.id
          : expect.any(String),
        inputTokens: 60,
        outputTokens: 20,
        estimatedCostUsd: "0.000100",
        metadata: expect.objectContaining({
          checkpointVersion: 3,
          transcriptSeq: 72,
          latencyMs: 88,
        }),
      });
      expect(bucket).toMatchObject({
        reservedUsd: "0.000000",
        consumedUsd: "0.000100",
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });

  it("预算关闭时同一 Checkpoint 边界仍只生成一条用量账本", async () => {
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const firstRun = await createAgentRunRecordFixture(database.database);
      const secondRun = await createFollowUpAgentRunFixture(
        database.database,
        firstRun,
      );
      const reservations = await Promise.all(
        [firstRun, secondRun].map((run) =>
          reserveContextCheckpointUsageBudget({
            ownerId: OWNER_ID,
            agentRunId: run.id,
            conversationId: firstRun.conversationId,
            checkpointVersion: 4,
            transcriptSeq: 96,
            provider: "deepseek",
            model: "deepseek-v4-flash",
            estimatedInputTokens: 80,
            maxOutputTokens: 120,
          }),
        ),
      );
      const acquired = reservations.filter(
        (reservation) => reservation?.acquired,
      );
      expect(acquired).toHaveLength(1);
      expect(
        reservations.filter((reservation) => !reservation?.acquired),
      ).toHaveLength(1);

      await settleContextCheckpointUsageBudget({
        reservation: acquired[0]!,
        provider: "deepseek",
        inputTokens: 55,
        outputTokens: 15,
        providerRequestStarted: true,
        usageObserved: true,
        latencyMs: 76,
      });

      const ledgers = await database.database
        .select()
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.resource, "context_checkpoint"),
            eq(usageLedger.ownerId, OWNER_ID),
          ),
        );
      expect(ledgers).toHaveLength(1);
      expect(ledgers[0]).toMatchObject({
        status: "settled",
        inputTokens: 55,
        outputTokens: 15,
        estimatedCostUsd: "0.000000",
        metadata: expect.objectContaining({
          checkpointVersion: 4,
          transcriptSeq: 96,
          latencyMs: 76,
          costEstimation: "pending_price_table",
        }),
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });

  it("Checkpoint Claim 过期后可被后续 Run 接管且不重复占用预算", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.02 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const firstRun = await createAgentRunRecordFixture(database.database);
      const secondRun = await createFollowUpAgentRunFixture(
        database.database,
        firstRun,
      );
      const input = {
        ownerId: OWNER_ID,
        conversationId: firstRun.conversationId,
        checkpointVersion: 5,
        transcriptSeq: 120,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
      } as const;
      const first = await reserveContextCheckpointUsageBudget({
        ...input,
        agentRunId: firstRun.id,
      });
      if (!first?.claimId) {
        throw new Error("首个 Checkpoint reservation 必须取得 Claim。");
      }

      const [ledgerBeforeTakeover] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      await database.database
        .update(usageLedger)
        .set({
          metadata: {
            ...ledgerBeforeTakeover!.metadata,
            claimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
        })
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));

      const second = await reserveContextCheckpointUsageBudget({
        ...input,
        agentRunId: secondRun.id,
      });
      expect(second).toMatchObject({
        acquired: true,
        alreadySettled: false,
        reservedCostUsd: first.reservedCostUsd,
      });
      expect(second?.claimId).not.toBe(first.claimId);

      const [ledgerAfterTakeover] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      const [bucket] = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));
      expect(ledgerAfterTakeover).toMatchObject({
        status: "reserved",
        agentRunId: secondRun.id,
        estimatedCostUsd: first.reservedCostUsd,
        metadata: expect.objectContaining({
          claimId: second?.claimId,
        }),
      });
      expect(bucket).toMatchObject({
        reservedUsd: first.reservedCostUsd,
        consumedUsd: "0.000000",
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });

  it("旧 Checkpoint Claim 无法释放或结算接管后的新 Claim", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.02 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const firstRun = await createAgentRunRecordFixture(database.database);
      const secondRun = await createFollowUpAgentRunFixture(
        database.database,
        firstRun,
      );
      const input = {
        ownerId: OWNER_ID,
        conversationId: firstRun.conversationId,
        checkpointVersion: 6,
        transcriptSeq: 144,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        estimatedInputTokens: 100,
        maxOutputTokens: 200,
      } as const;
      const first = await reserveContextCheckpointUsageBudget({
        ...input,
        agentRunId: firstRun.id,
      });
      if (!first?.claimId) {
        throw new Error("首个 Checkpoint reservation 必须取得 Claim。");
      }

      const [ledger] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      await database.database
        .update(usageLedger)
        .set({
          metadata: {
            ...ledger!.metadata,
            claimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
          },
        })
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      const second = await reserveContextCheckpointUsageBudget({
        ...input,
        agentRunId: secondRun.id,
      });
      if (!second?.claimId || second.claimId === first.claimId) {
        throw new Error("过期 Claim 必须由新的持有者接管。");
      }

      // 旧实例可能在租约过期后才收到 Provider 结果，甚至执行异常清理。
      // 两条路径都必须被 claimId 校验拦截，不能释放或结算新持有者的账本。
      await settleContextCheckpointUsageBudget({
        reservation: first,
        provider: "deepseek",
        inputTokens: 0,
        outputTokens: 0,
        providerRequestStarted: false,
        usageObserved: false,
        latencyMs: 10,
      });
      await settleContextCheckpointUsageBudget({
        reservation: first,
        provider: "deepseek",
        inputTokens: 999,
        outputTokens: 999,
        providerRequestStarted: true,
        usageObserved: true,
        latencyMs: 999,
      });

      const [stillReserved] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      expect(stillReserved).toMatchObject({
        status: "reserved",
        inputTokens: 0,
        outputTokens: 0,
        metadata: expect.objectContaining({
          claimId: second.claimId,
        }),
      });

      await settleContextCheckpointUsageBudget({
        reservation: second,
        provider: "deepseek",
        inputTokens: 40,
        outputTokens: 10,
        providerRequestStarted: true,
        usageObserved: true,
        latencyMs: 42,
      });
      const [settled] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      expect(settled).toMatchObject({
        status: "settled",
        inputTokens: 40,
        outputTokens: 10,
        estimatedCostUsd: "0.000060",
        metadata: expect.objectContaining({
          claimId: second.claimId,
          latencyMs: 42,
        }),
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });

  it("重复幂等键不会重复预留，释放也不会产生副作用", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.0002 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const agentRunId = await createAgentRunFixture(database.database);
      const input = {
        ownerId: OWNER_ID,
        agentRunId,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        turn: 1,
        estimatedInputTokens: 50,
        maxOutputTokens: 50,
      } as const;
      const first = await reserveModelUsageBudget(input);
      const second = await reserveModelUsageBudget(input);

      if (!first || !second) {
        throw new Error("预算开启后重复模型调用必须创建 reservation。");
      }

      expect(second).toEqual(first);

      const beforeRelease = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));
      expect(beforeRelease[0]).toMatchObject({
        reservedUsd: "0.000150",
        consumedUsd: "0.000000",
      });

      await settleModelUsageBudget({
        reservation: first,
        provider: "deepseek",
        inputTokens: 0,
        outputTokens: 0,
        providerRequestStarted: false,
        usageObserved: false,
      });
      await settleModelUsageBudget({
        reservation: second,
        provider: "deepseek",
        inputTokens: 0,
        outputTokens: 0,
        providerRequestStarted: false,
        usageObserved: false,
      });

      const [ledger] = await database.database
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.idempotencyKey, first.idempotencyKey));
      const [bucket] = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));
      expect(ledger?.status).toBe("released");
      expect(bucket).toMatchObject({
        reservedUsd: "0.000000",
        consumedUsd: "0.000000",
      });
    } finally {
      await database.close();
    }
  });

  it("并发预留不能越过全局预算", async () => {
    enableBudget({ MAX_GLOBAL_DAILY_COST_USD: 0.0003 });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const firstAgentRunId = await createAgentRunFixture(database.database);
      const secondAgentRunId = await createAgentRunFixture(database.database);
      const results = await Promise.allSettled(
        [firstAgentRunId, secondAgentRunId].map((agentRunId, turn) =>
          reserveModelUsageBudget({
            ownerId: OWNER_ID,
            agentRunId,
            provider: "deepseek",
            model: "deepseek-v4-pro",
            turn,
            estimatedInputTokens: 100,
            maxOutputTokens: 100,
          }),
        ),
      );

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          code: QUOTA_ERROR_CODES.globalBudgetExhausted,
        }),
      });
    } finally {
      await database.close();
    }
  });

  it("预算开启但缺少价格时拒绝模型和图片调用", async () => {
    enableBudget({
      LLM_INPUT_COST_PER_1M_USD: undefined,
      LLM_OUTPUT_COST_PER_1M_USD: undefined,
      IMAGE_COST_PER_GENERATION_USD: undefined,
    });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const agentRunId = await createAgentRunFixture(database.database);
      const imageRunId = await createImageRunFixture(database.database);
      await expect(
        reserveModelUsageBudget({
          ownerId: OWNER_ID,
          agentRunId,
          provider: "deepseek",
          model: "deepseek-v4-pro",
          turn: 1,
          estimatedInputTokens: 10,
          maxOutputTokens: 10,
        }),
      ).rejects.toMatchObject({
        code: QUOTA_ERROR_CODES.globalBudgetPriceUnavailable,
      });
      await expect(
        reserveImageUsageBudget({
          ownerId: OWNER_ID,
          imageRunId,
          provider: "openai-compatible",
          model: "gpt-image-2",
          count: 1,
          size: "1024x1024",
          attempt: 1,
        }),
      ).rejects.toMatchObject({
        code: QUOTA_ERROR_CODES.globalBudgetPriceUnavailable,
      });
    } finally {
      await database.close();
    }
  });

  it("图片调用已发起但响应失败时仍结算，未发起时才释放", async () => {
    enableBudget({
      MAX_GLOBAL_DAILY_COST_USD: 0.0003,
      IMAGE_COST_PER_GENERATION_USD: 0.0001,
    });
    const database = await createTestDatabase();
    databaseRef.current = database.database as unknown as TestDatabase;
    try {
      const chargedImageRunId = await createImageRunFixture(database.database);
      const charged = await reserveImageUsageBudget({
        ownerId: OWNER_ID,
        imageRunId: chargedImageRunId,
        provider: "openai-compatible",
        model: "gpt-image-2",
        count: 1,
        size: "1024x1024",
        attempt: 1,
      });
      if (!charged) {
        throw new Error("预算开启后图片调用必须创建 reservation。");
      }
      await settleImageUsageBudget({
        reservation: charged,
        providerRequestStarted: true,
        providerResponseReceived: false,
      });

      const releasedImageRunId = await createImageRunFixture(database.database);
      const released = await reserveImageUsageBudget({
        ownerId: OWNER_ID,
        imageRunId: releasedImageRunId,
        provider: "openai-compatible",
        model: "gpt-image-2",
        count: 1,
        size: "1024x1024",
        attempt: 1,
      });
      if (!released) {
        throw new Error("预算开启后图片调用必须创建 reservation。");
      }
      await settleImageUsageBudget({
        reservation: released,
        providerRequestStarted: false,
        providerResponseReceived: false,
      });

      const ledgers = await database.database
        .select()
        .from(usageLedger)
        .where(
          and(
            eq(usageLedger.resource, "image_generation"),
            eq(usageLedger.ownerId, OWNER_ID),
          ),
        );
      const bucket = await database.database
        .select()
        .from(dailyBudgetBuckets)
        .where(eq(dailyBudgetBuckets.bucketDate, utcDateKey()));

      expect(ledgers.map((ledger) => ledger.status)).toEqual(
        expect.arrayContaining(["settled", "released"]),
      );
      expect(bucket[0]).toMatchObject({
        reservedUsd: "0.000000",
        consumedUsd: "0.000100",
      });
    } finally {
      await database.close();
      databaseRef.current = null;
    }
  });
});
