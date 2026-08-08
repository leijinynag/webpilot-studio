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
  reserveImageUsageBudget,
  reserveModelUsageBudget,
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
async function createAgentRunFixture(
  database: ConstructorParameters<typeof DatabaseProjectRepository>[0],
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
    conversationTitle: "预算测试",
    userMessage: "预算测试消息",
    profile,
    startRevision: project.revision,
  });

  return run.id;
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
