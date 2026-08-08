import "server-only";

import { createHmac } from "node:crypto";

import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";

import { QUOTA_ERROR_CODES, QuotaError } from "@/infrastructure/quota/errors";
import {
  getDatabase,
  runDatabaseTransaction,
} from "@/infrastructure/db/client";
import {
  dailyBudgetBuckets,
  imageRuns,
  quotaBuckets,
  quotaLeases,
  usageLedger,
} from "@/infrastructure/db/schema";
import { serverEnv } from "@/infrastructure/env/server";
import {
  isRedisRateLimitConfigured,
  RedisRateLimitRejectedError,
  RedisRateLimitStorageError,
  releaseRedisRateLimit,
  reserveRedisRateLimit,
  type RedisRateLimitReservation,
} from "@/infrastructure/rate-limit/upstash-store";

export type QuotaResource =
  "agent_run" | "image_generation" | "attachment_upload";

type QuotaSubjectType = "ip" | "owner" | "global";

export type QuotaReservation = {
  resource: QuotaResource;
  ownerId: string;
  leaseIds: string[];
  bucketDate: string;
  bucketSubjects: Array<{
    subjectType: Exclude<QuotaSubjectType, "global">;
    subjectKey: string;
  }>;
  units: number;
  correlationId?: string;
  redisReservation?: RedisRateLimitReservation;
};

export type UsageBudgetReservation = {
  idempotencyKey: string;
  bucketDate: string;
  reservedCostUsd: string;
};

/**
 * 图片 Worker 和历史兼容入口需要知道当前是否启用了全局费用账本。
 * 预算未配置时继续保留旧的 usage ledger 行为；预算开启后必须走
 * reserved -> settled/released 的完整状态机，不能再写 pending_price_table。
 */
export function isGlobalBudgetEnabled(): boolean {
  return getGlobalDailyBudgetLimitMicros() !== null;
}

type ModelPricingKind = "llm" | "vision";

type QuotaPolicy = {
  ipDailyLimit: number;
  ownerDailyLimit: number;
  ownerConcurrentLimit: number;
  globalConcurrentLimit: number;
  leaseMilliseconds: number;
};

const DEFAULT_POLICIES: Record<QuotaResource, QuotaPolicy> = {
  agent_run: {
    ipDailyLimit: 5,
    ownerDailyLimit: 10,
    ownerConcurrentLimit: 1,
    globalConcurrentLimit: 20,
    leaseMilliseconds: 35 * 60 * 1_000,
  },
  image_generation: {
    ipDailyLimit: 20,
    ownerDailyLimit: 5,
    ownerConcurrentLimit: 1,
    globalConcurrentLimit: 2,
    leaseMilliseconds: 10 * 60 * 1_000,
  },
  attachment_upload: {
    ipDailyLimit: 20,
    ownerDailyLimit: 50,
    ownerConcurrentLimit: 2,
    globalConcurrentLimit: 8,
    leaseMilliseconds: 10 * 60 * 1_000,
  },
};

// PostgreSQL integer 的最大值。global bucket 不参与日额度判断，但仍需要
// 一个合法的占位值来满足数据库约束，不能写入 Number.MAX_SAFE_INTEGER。
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const USD_SCALE = 1_000_000;

/**
 * 额度和并发保护先使用 PostgreSQL 事实层。
 *
 * 每个资源的 owner/global 日桶同时承担并发竞争的行锁，因此“检查数量 +
 * 写入租约”在多个 Vercel 实例之间仍然是原子的。后续接入 Redis 时只替换
 * 这个模块的高频实现，不改变 API 和领域层的保护顺序。
 */
export async function reserveQuota(input: {
  resource: QuotaResource;
  ownerId: string;
  request?: Request;
  ipSubjectKey?: string;
  units?: number;
  countTowardDailyQuota?: boolean;
  correlationId?: string;
}): Promise<QuotaReservation> {
  const policy = getQuotaPolicy(input.resource);
  const countTowardDailyQuota = input.countTowardDailyQuota !== false;
  const units = countTowardDailyQuota ? normalizeQuotaUnits(input.units) : 0;
  const bucketDate = getUtcDateKey();
  const ipKey =
    input.ipSubjectKey ??
    (input.request ? hashClientIp(getClientIp(input.request)) : null);
  const subjects: Array<{
    subjectType: QuotaSubjectType;
    subjectKey: string;
    limit: number;
  }> = [
    {
      subjectType: "owner",
      subjectKey: input.ownerId,
      limit: policy.ownerDailyLimit,
    },
    {
      subjectType: "global",
      subjectKey: "global",
      limit: POSTGRES_INTEGER_MAX,
    },
  ];

  if (ipKey) {
    subjects.unshift({
      subjectType: "ip",
      subjectKey: ipKey,
      limit: policy.ipDailyLimit,
    });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.leaseMilliseconds);
  const redisConfigured = isRedisRateLimitConfigured({
    url: serverEnv.REDIS_URL,
    token: serverEnv.REDIS_TOKEN,
  });
  const redisRequired = serverEnv.RATE_LIMIT_REDIS_REQUIRED === "true";
  let redisReservation: RedisRateLimitReservation | undefined;

  // Redis 是高频准入层，先做一次原子检查，避免明显超量的请求进入
  // PostgreSQL 行锁竞争。数据库写入失败时会在下面补偿释放 Redis lease。
  if (redisRequired && !redisConfigured) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.rateLimitStorageUnavailable,
      "生产环境必须配置 Redis 限流存储。",
      503,
    );
  }
  if (redisConfigured) {
    try {
      redisReservation = await reserveRedisRateLimit({
        redis: {
          url: serverEnv.REDIS_URL,
          token: serverEnv.REDIS_TOKEN,
        },
        policy: {
          resource: input.resource,
          ownerId: input.ownerId,
          ipSubjectKey: ipKey ?? undefined,
          bucketDate,
          units,
          countTowardDailyQuota,
          ...policy,
        },
      });
    } catch (error) {
      if (error instanceof RedisRateLimitRejectedError) {
        if (error.reason === "daily") {
          throw new QuotaError(
            QUOTA_ERROR_CODES.dailyQuotaExhausted,
            "今日使用额度已用尽，请明天再试。",
            429,
            {
              resource: input.resource,
              scope: error.scope,
              retryAfterSeconds: error.retryAfterSeconds,
            },
          );
        }
        throw new QuotaError(
          QUOTA_ERROR_CODES.tooManyConcurrentRuns,
          "服务当前运行数量已达到上限，请稍后重试。",
          429,
          {
            resource: input.resource,
            scope: error.scope,
            retryAfterSeconds: error.retryAfterSeconds,
          },
        );
      }
      if (error instanceof RedisRateLimitStorageError && !redisRequired) {
        console.warn("[quota] redis unavailable; fallback to PostgreSQL", {
          resource: input.resource,
          ownerId: input.ownerId,
          error,
        });
      } else {
        throw new QuotaError(
          QUOTA_ERROR_CODES.rateLimitStorageUnavailable,
          "限流存储暂不可用，请稍后重试。",
          503,
        );
      }
    }
  }

  try {
    const postgresReservation = await runDatabaseTransaction(async (tx) => {
      await tx
        .insert(quotaBuckets)
        .values(
          subjects.map((subject) => ({
            resource: input.resource,
            subjectType: subject.subjectType,
            subjectKey: subject.subjectKey,
            bucketDate,
            limit: subject.limit,
            consumed: 0,
          })),
        )
        .onConflictDoNothing();

      const lockedBuckets = [];
      for (const subject of subjects) {
        const [bucket] = await tx
          .select()
          .from(quotaBuckets)
          .where(
            and(
              eq(quotaBuckets.resource, input.resource),
              eq(quotaBuckets.subjectType, subject.subjectType),
              eq(quotaBuckets.subjectKey, subject.subjectKey),
              eq(quotaBuckets.bucketDate, bucketDate),
            ),
          )
          .for("update");

        if (!bucket) {
          throw new QuotaError(
            QUOTA_ERROR_CODES.storageUnavailable,
            "额度存储暂不可用，请稍后重试。",
            503,
          );
        }
        lockedBuckets.push(bucket);
      }

      // global 桶的 limit 只用于占位和锁竞争，不作为每日运行次数限制。
      for (const bucket of lockedBuckets) {
        const subject = subjects.find(
          (candidate) =>
            candidate.subjectType === bucket.subjectType &&
            candidate.subjectKey === bucket.subjectKey,
        )!;
        if (bucket.subjectType === "global" || !countTowardDailyQuota) {
          continue;
        }
        if (bucket.consumed + units > subject.limit) {
          throw new QuotaError(
            QUOTA_ERROR_CODES.dailyQuotaExhausted,
            "今日使用额度已用尽，请明天再试。",
            429,
            {
              resource: input.resource,
              subjectType: bucket.subjectType,
              limit: subject.limit,
              consumed: bucket.consumed,
              requested: units,
              bucketDate,
            },
          );
        }
      }

      await tx
        .update(quotaLeases)
        .set({
          status: "expired",
          updatedAt: now,
        })
        .where(
          and(
            eq(quotaLeases.resource, input.resource),
            eq(quotaLeases.status, "active"),
            lte(quotaLeases.expiresAt, now),
          ),
        );

      const ownerActiveLeases = await countActiveLeases(tx, {
        resource: input.resource,
        ownerId: input.ownerId,
        now,
      });
      if (ownerActiveLeases >= policy.ownerConcurrentLimit) {
        throw new QuotaError(
          QUOTA_ERROR_CODES.tooManyConcurrentRuns,
          "当前运行数量已达到上限，请等待已有任务完成。",
          429,
          {
            resource: input.resource,
            scope: "owner",
            active: ownerActiveLeases,
            limit: policy.ownerConcurrentLimit,
          },
        );
      }

      const globalActiveLeases = await countActiveLeases(tx, {
        resource: input.resource,
        now,
      });
      if (globalActiveLeases >= policy.globalConcurrentLimit) {
        throw new QuotaError(
          QUOTA_ERROR_CODES.tooManyConcurrentRuns,
          "服务当前运行数量已达到上限，请稍后重试。",
          429,
          {
            resource: input.resource,
            scope: "global",
            active: globalActiveLeases,
            limit: policy.globalConcurrentLimit,
          },
        );
      }

      await Promise.all(
        lockedBuckets
          .filter((bucket) => bucket.subjectType !== "global")
          .map((bucket) =>
            tx
              .update(quotaBuckets)
              .set({
                consumed: bucket.consumed + units,
                updatedAt: now,
              })
              .where(eq(quotaBuckets.id, bucket.id)),
          ),
      );

      const leases = await tx
        .insert(quotaLeases)
        .values(
          [
            { subjectKey: input.ownerId, subjectType: "owner" as const },
            { subjectKey: "global", subjectType: "global" as const },
          ].map((subject) => ({
            resource: input.resource,
            ownerId: input.ownerId,
            subjectKey: subject.subjectKey,
            status: "active" as const,
            expiresAt,
            correlationId: input.correlationId,
            metadata: {
              resource: input.resource,
              subjectType: subject.subjectType,
            },
          })),
        )
        .returning({ id: quotaLeases.id });

      return {
        resource: input.resource,
        ownerId: input.ownerId,
        leaseIds: leases.map((lease) => lease.id),
        bucketDate,
        bucketSubjects: subjects
          .filter(
            (
              subject,
            ): subject is {
              subjectType: Exclude<QuotaSubjectType, "global">;
              subjectKey: string;
              limit: number;
            } => subject.subjectType !== "global",
          )
          .map(({ subjectType, subjectKey }) => ({ subjectType, subjectKey })),
        units,
        correlationId: input.correlationId,
        redisReservation,
      };
    });

    return postgresReservation;
  } catch (error) {
    if (redisReservation) {
      try {
        await releaseRedisRateLimit({
          redis: {
            url: serverEnv.REDIS_URL,
            token: serverEnv.REDIS_TOKEN,
          },
          reservation: redisReservation,
          refundDailyQuota: true,
        });
      } catch (releaseError) {
        console.error("[quota] redis reservation rollback failed", {
          resource: input.resource,
          leaseId: redisReservation.leaseId,
          releaseError,
        });
      }
    }
    throw error;
  }
}

export async function bindQuotaReservation(input: {
  reservation: QuotaReservation;
  resourceId: string;
}): Promise<void> {
  if (input.reservation.leaseIds.length === 0) {
    return;
  }

  await getDatabase()
    .update(quotaLeases)
    .set({
      // 使用 JSONB 合并而不是整体覆盖，保留每条 lease 自己的
      // subjectType。并发统计和后台恢复都依赖这个字段。
      metadata: sql`${quotaLeases.metadata} || ${JSON.stringify({
        resource: input.reservation.resource,
        resourceId: input.resourceId,
        ipSubjectKey:
          input.reservation.bucketSubjects.find(
            (subject) => subject.subjectType === "ip",
          )?.subjectKey ?? null,
        ...(input.reservation.redisReservation
          ? { redisReservation: input.reservation.redisReservation }
          : {}),
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(inArray(quotaLeases.id, input.reservation.leaseIds));
}

export async function ensureQuotaLease(input: {
  resource: QuotaResource;
  ownerId: string;
  resourceId: string;
  correlationId?: string;
  ipSubjectKey?: string;
}): Promise<void> {
  const now = new Date();
  const [activeLease] = await getDatabase()
    .select({ id: quotaLeases.id })
    .from(quotaLeases)
    .where(
      and(
        eq(quotaLeases.resource, input.resource),
        eq(quotaLeases.ownerId, input.ownerId),
        eq(quotaLeases.status, "active"),
        gt(quotaLeases.expiresAt, now),
        sql`${quotaLeases.metadata}->>'resourceId' = ${input.resourceId}`,
      ),
    )
    .limit(1);

  if (activeLease) {
    return;
  }

  // 恢复一个已经创建过的 Run 只重新占用并发 lease，不重复扣除
  // 每日免费次数；真实模型 token 仍由 usage_ledger 单独记录。
  const reservation = await reserveQuota({
    resource: input.resource,
    ownerId: input.ownerId,
    ipSubjectKey: input.ipSubjectKey,
    countTowardDailyQuota: false,
    correlationId: input.correlationId,
  });
  await bindQuotaReservation({
    reservation,
    resourceId: input.resourceId,
  });
}

/**
 * 从已绑定的父资源租约中恢复匿名 IP 额度键。
 *
 * 生图由队列 Worker 触发，无法再读取首个 HTTP 请求的客户端 IP。这里读取
 * 绑定在 Agent lease metadata 中的每日 HMAC 摘要，避免把原始 IP 或额外的
 * 身份信息写入 Agent Run。
 */
export async function getQuotaIpSubjectKey(input: {
  resource: QuotaResource;
  resourceId: string;
}): Promise<string | undefined> {
  const [lease] = await getDatabase()
    .select({ metadata: quotaLeases.metadata })
    .from(quotaLeases)
    .where(
      and(
        eq(quotaLeases.resource, input.resource),
        sql`${quotaLeases.metadata}->>'resourceId' = ${input.resourceId}`,
        sql`${quotaLeases.metadata}->>'subjectType' = 'owner'`,
      ),
    )
    .limit(1);

  const subjectKey = lease?.metadata.ipSubjectKey;
  return typeof subjectKey === "string" && subjectKey.length > 0
    ? subjectKey
    : undefined;
}

export async function releaseQuotaReservation(input: {
  reservation?: QuotaReservation;
  resource?: QuotaResource;
  resourceId?: string;
  ownerId?: string;
  refundUnits?: number;
}): Promise<void> {
  const now = new Date();
  const refundUnits = Math.max(0, Math.floor(input.refundUnits ?? 0));
  let redisReservation = input.reservation?.redisReservation;
  let refundRedisDailyQuota = false;

  // 终态清理通常只传 resourceId。先读取已绑定的 Redis reservation，
  // 再完成 PostgreSQL 租约迁移，避免 Redis 租约因为业务上下文丢失而泄漏。
  if (!redisReservation && input.resourceId) {
    const leaseFilter = and(
      input.resource ? eq(quotaLeases.resource, input.resource) : undefined,
      sql`${quotaLeases.metadata}->>'resourceId' = ${input.resourceId}`,
    );
    const [lease] = await getDatabase()
      .select({ metadata: quotaLeases.metadata })
      .from(quotaLeases)
      .where(and(eq(quotaLeases.status, "active"), leaseFilter))
      .limit(1);
    redisReservation = readRedisReservation(lease?.metadata);
  }

  await runDatabaseTransaction(async (tx) => {
    const leaseFilter = input.reservation
      ? inArray(quotaLeases.id, input.reservation.leaseIds)
      : input.resourceId
        ? and(
            input.resource
              ? eq(quotaLeases.resource, input.resource)
              : undefined,
            sql`${quotaLeases.metadata}->>'resourceId' = ${input.resourceId}`,
          )
        : input.resource && input.ownerId
          ? and(
              eq(quotaLeases.resource, input.resource),
              eq(quotaLeases.ownerId, input.ownerId),
            )
          : undefined;

    if (!leaseFilter) {
      return;
    }

    const leases = await tx
      .select({
        id: quotaLeases.id,
        metadata: quotaLeases.metadata,
      })
      .from(quotaLeases)
      .where(and(eq(quotaLeases.status, "active"), leaseFilter))
      .for("update");

    if (leases.length === 0) {
      return;
    }

    // 只有尚未绑定资源的 reservation 才允许回退日额度。已经绑定到
    // Agent/Image Run 的租约代表真实副作用，终态只能释放并发占用。
    if (
      refundUnits > 0 &&
      input.reservation &&
      !leases.some((lease) => typeof lease.metadata.resourceId === "string")
    ) {
      const unitsToRefund = Math.min(refundUnits, input.reservation.units);
      refundRedisDailyQuota = unitsToRefund > 0;
      for (const subject of input.reservation.bucketSubjects) {
        const [bucket] = await tx
          .select({
            id: quotaBuckets.id,
            consumed: quotaBuckets.consumed,
          })
          .from(quotaBuckets)
          .where(
            and(
              eq(quotaBuckets.resource, input.reservation.resource),
              eq(quotaBuckets.subjectType, subject.subjectType),
              eq(quotaBuckets.subjectKey, subject.subjectKey),
              eq(quotaBuckets.bucketDate, input.reservation.bucketDate),
            ),
          )
          .for("update");

        if (bucket) {
          await tx
            .update(quotaBuckets)
            .set({
              consumed: Math.max(0, bucket.consumed - unitsToRefund),
              updatedAt: now,
            })
            .where(eq(quotaBuckets.id, bucket.id));
        }
      }
    }

    await tx
      .update(quotaLeases)
      .set({
        status: "released",
        releasedAt: now,
        updatedAt: now,
      })
      .where(
        inArray(
          quotaLeases.id,
          leases.map((lease) => lease.id),
        ),
      );
  });

  if (redisReservation) {
    try {
      await releaseRedisRateLimit({
        redis: {
          url: serverEnv.REDIS_URL,
          token: serverEnv.REDIS_TOKEN,
        },
        reservation: redisReservation,
        refundDailyQuota: refundRedisDailyQuota,
      });
    } catch (error) {
      // 数据库终态不能因为 Redis 清理网络失败而回滚。Redis lease
      // 带有 TTL，后台监控可根据该日志补偿清理。
      console.error("[quota] redis reservation release failed", {
        resource: redisReservation.resource,
        leaseId: redisReservation.leaseId,
        error,
      });
    }
  }
}

export async function settleQuotaReservation(input: {
  reservation: QuotaReservation;
}): Promise<void> {
  await releaseQuotaReservation({ reservation: input.reservation });
}

/**
 * 释放 Agent Run 自身以及它名下仍未完成生图任务的并发租约。
 *
 * Agent 取消发生在父 Run 上，而图片额度绑定在 imageRun 上。这里按 owner、
 * parentAgentRunId 和资源类型精确筛选，避免按匿名 owner 全量释放其他项目。
 */
export async function releaseAgentRunQuotaReservations(input: {
  ownerId: string;
  runId: string;
}): Promise<void> {
  const pendingImageRuns = await getDatabase()
    .select({ id: imageRuns.id })
    .from(imageRuns)
    .where(
      and(
        eq(imageRuns.ownerId, input.ownerId),
        eq(imageRuns.parentAgentRunId, input.runId),
        inArray(imageRuns.status, ["queued", "running"]),
      ),
    );

  await releaseQuotaReservation({
    resource: "agent_run",
    resourceId: input.runId,
  });
  await Promise.all(
    pendingImageRuns.map((imageRun) =>
      releaseQuotaReservation({
        resource: "image_generation",
        resourceId: imageRun.id,
      }),
    ),
  );
}

/**
 * 在 Provider 调用前预留本轮最大可能成本。
 *
 * 输入 token 使用当前消息字符数的保守估算，输出 token 使用已经传给 Provider
 * 的 maxOutputTokens。账本和每日预算桶在同一事务中更新，因此并发请求无法
 * 同时看到旧余额后一起越过熔断线。
 */
export async function reserveModelUsageBudget(input: {
  ownerId: string;
  agentRunId: string;
  provider: string;
  model: string;
  turn: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}): Promise<UsageBudgetReservation | null> {
  // 没有开启全局预算时不要求填写价格。这样本地开发和已有测试仍然可以
  // 使用旧的 usage ledger 记录路径，不会因为成本配置缺失阻断普通 Agent。
  if (getGlobalDailyBudgetLimitMicros() === null) {
    return null;
  }

  const pricingKind = getModelPricingKind(input.provider);
  const pricing = requireTokenPricing(pricingKind);
  const reservedInputTokens = Math.max(
    1,
    Math.ceil(input.estimatedInputTokens),
  );
  const reservedOutputTokens = Math.max(1, Math.ceil(input.maxOutputTokens));
  const reservedCostMicros = estimateTokenCostMicros({
    inputTokens: reservedInputTokens,
    outputTokens: reservedOutputTokens,
    inputCostPerMillionUsd: pricing.inputCostPerMillionUsd,
    outputCostPerMillionUsd: pricing.outputCostPerMillionUsd,
  });
  const idempotencyKey = `agent-turn:${input.agentRunId}:${input.turn}`;

  return reserveUsageBudget({
    ownerId: input.ownerId,
    resource: "agent_run",
    agentRunId: input.agentRunId,
    provider: input.provider,
    model: input.model,
    idempotencyKey,
    reservedInputTokens,
    reservedOutputTokens,
    reservedCostMicros,
    metadata: {
      turn: input.turn,
      pricingKind,
      costEstimation: "configured_token_price",
    },
  });
}

/**
 * Provider 返回 usage 后按真实 token 结算；若请求已经产生流事件但上游没有
 * usage 尾帧，则按预留上限结算，宁可保守熔断也不能把未知账单当作零成本。
 */
export async function settleModelUsageBudget(input: {
  reservation: UsageBudgetReservation | null;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  providerRequestStarted: boolean;
  usageObserved: boolean;
}): Promise<void> {
  if (!input.reservation) {
    return;
  }

  if (!input.providerRequestStarted) {
    await releaseUsageBudget(input.reservation);
    return;
  }

  const pricing = requireTokenPricing(getModelPricingKind(input.provider));
  const actualCostMicros = input.usageObserved
    ? estimateTokenCostMicros({
        inputTokens: Math.max(0, input.inputTokens),
        outputTokens: Math.max(0, input.outputTokens),
        inputCostPerMillionUsd: pricing.inputCostPerMillionUsd,
        outputCostPerMillionUsd: pricing.outputCostPerMillionUsd,
      })
    : undefined;

  await settleUsageBudget({
    reservation: input.reservation,
    inputTokens: Math.max(0, input.inputTokens),
    outputTokens: Math.max(0, input.outputTokens),
    actualCostMicros,
    metadata: {
      usageObserved: input.usageObserved,
      costEstimation: input.usageObserved
        ? "configured_token_price"
        : "reserved_upper_bound",
    },
  });
}

export async function reserveImageUsageBudget(input: {
  ownerId: string;
  imageRunId: string;
  provider: string;
  model: string;
  count: number;
  size: string;
  attempt: number;
}): Promise<UsageBudgetReservation | null> {
  if (getGlobalDailyBudgetLimitMicros() === null) {
    return null;
  }

  const pricePerImageUsd = requireImagePrice();
  const reservedCostMicros = Math.max(
    Math.ceil(Math.max(1, input.count) * pricePerImageUsd * USD_SCALE),
  );

  return reserveUsageBudget({
    ownerId: input.ownerId,
    resource: "image_generation",
    imageRunId: input.imageRunId,
    provider: input.provider,
    model: input.model,
    idempotencyKey: `image-run:${input.imageRunId}:attempt:${input.attempt}`,
    reservedInputTokens: 0,
    reservedOutputTokens: 0,
    reservedCostMicros,
    metadata: {
      count: input.count,
      size: input.size,
      attempt: input.attempt,
      costEstimation: "configured_image_price",
    },
  });
}

export async function settleImageUsageBudget(input: {
  reservation: UsageBudgetReservation | null;
  providerRequestStarted: boolean;
  providerResponseReceived: boolean;
  providerJobId?: string;
}): Promise<void> {
  if (!input.reservation) {
    return;
  }

  if (!input.providerRequestStarted) {
    await releaseUsageBudget(input.reservation);
    return;
  }

  // 生图供应商可能已经接受请求并产生计费，即使本地在拿到完整响应前
  // 发生超时或连接断开。因此只要请求已经发出，就按预留单价结算；
  // providerResponseReceived 仅作为账本诊断字段，不决定是否收费。
  await settleUsageBudget({
    reservation: input.reservation,
    metadata: {
      ...(input.providerJobId ? { providerJobId: input.providerJobId } : {}),
      costEstimation: "configured_image_price",
      providerResponseReceived: input.providerResponseReceived,
    },
  });
}

/**
 * 创建昂贵任务前的快速熔断检查。
 *
 * 真正防并发超卖的是 reserveUsageBudget 的行锁；这里用于在日额度和并发
 * lease 之前给已经耗尽预算的请求返回正确错误码。
 */
export async function assertGlobalBudgetAvailable(): Promise<void> {
  const limitMicros = getGlobalDailyBudgetLimitMicros();
  if (limitMicros === null) {
    return;
  }

  const bucketDate = getUtcDateKey();
  const [bucket] = await getDatabase()
    .select({
      reservedUsd: dailyBudgetBuckets.reservedUsd,
      consumedUsd: dailyBudgetBuckets.consumedUsd,
    })
    .from(dailyBudgetBuckets)
    .where(eq(dailyBudgetBuckets.bucketDate, bucketDate))
    .limit(1);
  const usedMicros =
    usdStringToMicros(bucket?.reservedUsd) +
    usdStringToMicros(bucket?.consumedUsd);

  if (usedMicros >= limitMicros) {
    throw createGlobalBudgetError({
      bucketDate,
      limitMicros,
      usedMicros,
      requestedMicros: 0,
    });
  }
}

/**
 * 在一个事务内写入 usage ledger，并原子增加当天预算桶的 reservedUsd。
 *
 * 这里先锁定已有的幂等记录，再锁定自然日预算桶。恢复执行或队列重复投递
 * 时，已经存在的 reservation 会直接复用，避免同一个 Provider 请求重复占用
 * 全局预算。
 */
async function reserveUsageBudget(input: {
  ownerId: string;
  resource: QuotaResource;
  agentRunId?: string;
  imageRunId?: string;
  provider: string;
  model: string;
  idempotencyKey: string;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedCostMicros: number;
  metadata: Record<string, unknown>;
}): Promise<UsageBudgetReservation> {
  const limitMicros = getGlobalDailyBudgetLimitMicros();
  if (limitMicros === null) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.storageUnavailable,
      "全局预算未启用，不能创建预算预留。",
      500,
    );
  }

  const bucketDate = getUtcDateKey();
  const requestedCostMicros = Math.max(0, Math.ceil(input.reservedCostMicros));

  return runDatabaseTransaction(async (tx) => {
    const [existing] = await tx
      .select({
        idempotencyKey: usageLedger.idempotencyKey,
        status: usageLedger.status,
        estimatedCostUsd: usageLedger.estimatedCostUsd,
        metadata: usageLedger.metadata,
      })
      .from(usageLedger)
      .where(eq(usageLedger.idempotencyKey, input.idempotencyKey))
      .for("update");

    if (existing) {
      if (existing.status !== "reserved") {
        return {
          idempotencyKey: existing.idempotencyKey,
          bucketDate,
          reservedCostUsd: "0",
        };
      }

      const existingBucketDate =
        typeof existing.metadata.bucketDate === "string"
          ? existing.metadata.bucketDate
          : bucketDate;
      return {
        idempotencyKey: existing.idempotencyKey,
        bucketDate: existingBucketDate,
        reservedCostUsd: existing.estimatedCostUsd,
      };
    }

    await tx
      .insert(dailyBudgetBuckets)
      .values({
        bucketDate,
        limitUsd: microsToUsdString(limitMicros),
        reservedUsd: "0",
        consumedUsd: "0",
      })
      .onConflictDoNothing({
        target: dailyBudgetBuckets.bucketDate,
      });

    const [bucket] = await tx
      .select()
      .from(dailyBudgetBuckets)
      .where(eq(dailyBudgetBuckets.bucketDate, bucketDate))
      .for("update");

    if (!bucket) {
      throw new QuotaError(
        QUOTA_ERROR_CODES.storageUnavailable,
        "全局预算存储暂不可用，请稍后重试。",
        503,
      );
    }

    const reservedMicros = usdStringToMicros(bucket.reservedUsd);
    const consumedMicros = usdStringToMicros(bucket.consumedUsd);
    const usedMicros = reservedMicros + consumedMicros;
    if (usedMicros + requestedCostMicros > limitMicros) {
      throw createGlobalBudgetError({
        bucketDate,
        limitMicros,
        usedMicros,
        requestedMicros: requestedCostMicros,
      });
    }

    const reservationMetadata = {
      ...input.metadata,
      bucketDate,
      reservedCostUsd: microsToUsdString(requestedCostMicros),
    };
    await tx.insert(usageLedger).values({
      ownerId: input.ownerId,
      resource: input.resource,
      agentRunId: input.agentRunId,
      imageRunId: input.imageRunId,
      provider: input.provider,
      model: input.model,
      status: "reserved",
      idempotencyKey: input.idempotencyKey,
      reservedInputTokens: Math.max(0, Math.floor(input.reservedInputTokens)),
      reservedOutputTokens: Math.max(0, Math.floor(input.reservedOutputTokens)),
      estimatedCostUsd: microsToUsdString(requestedCostMicros),
      metadata: reservationMetadata,
    });
    await tx
      .update(dailyBudgetBuckets)
      .set({
        reservedUsd: microsToUsdString(reservedMicros + requestedCostMicros),
        updatedAt: new Date(),
      })
      .where(eq(dailyBudgetBuckets.id, bucket.id));

    return {
      idempotencyKey: input.idempotencyKey,
      bucketDate,
      reservedCostUsd: microsToUsdString(requestedCostMicros),
    };
  });
}

/**
 * 结算已经预留的预算。重复结算不会再次增加 consumedUsd，因此队列重投、
 * Provider 回调和请求恢复都可以安全调用。
 */
async function settleUsageBudget(input: {
  reservation: UsageBudgetReservation;
  inputTokens?: number;
  outputTokens?: number;
  actualCostMicros?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await runDatabaseTransaction(async (tx) => {
    const [ledger] = await tx
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.idempotencyKey, input.reservation.idempotencyKey))
      .for("update");

    if (!ledger || ledger.status !== "reserved") {
      return;
    }

    const bucketDate =
      typeof ledger.metadata.bucketDate === "string"
        ? ledger.metadata.bucketDate
        : input.reservation.bucketDate;
    const [bucket] = await tx
      .select()
      .from(dailyBudgetBuckets)
      .where(eq(dailyBudgetBuckets.bucketDate, bucketDate))
      .for("update");
    if (!bucket) {
      throw new QuotaError(
        QUOTA_ERROR_CODES.storageUnavailable,
        "全局预算存储暂不可用，请稍后重试。",
        503,
      );
    }

    const reservedMicros = usdStringToMicros(ledger.estimatedCostUsd);
    const bucketReservedMicros = usdStringToMicros(bucket.reservedUsd);
    const bucketConsumedMicros = usdStringToMicros(bucket.consumedUsd);
    const actualCostMicros = Math.max(
      0,
      Math.ceil(input.actualCostMicros ?? reservedMicros),
    );
    const now = new Date();

    await tx
      .update(dailyBudgetBuckets)
      .set({
        reservedUsd: microsToUsdString(
          Math.max(0, bucketReservedMicros - reservedMicros),
        ),
        consumedUsd: microsToUsdString(bucketConsumedMicros + actualCostMicros),
        updatedAt: now,
      })
      .where(eq(dailyBudgetBuckets.id, bucket.id));
    await tx
      .update(usageLedger)
      .set({
        status: "settled",
        inputTokens: Math.max(0, Math.floor(input.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.floor(input.outputTokens ?? 0)),
        estimatedCostUsd: microsToUsdString(actualCostMicros),
        metadata: {
          ...ledger.metadata,
          ...(input.metadata ?? {}),
          settledCostUsd: microsToUsdString(actualCostMicros),
        },
        settledAt: now,
        updatedAt: now,
      })
      .where(eq(usageLedger.id, ledger.id));
  });
}

/**
 * Provider 请求尚未真正发生时释放预留；状态迁移和预算回退在同一事务中
 * 完成，重复释放同样没有副作用。
 */
async function releaseUsageBudget(
  reservation: UsageBudgetReservation,
): Promise<void> {
  await runDatabaseTransaction(async (tx) => {
    const [ledger] = await tx
      .select()
      .from(usageLedger)
      .where(eq(usageLedger.idempotencyKey, reservation.idempotencyKey))
      .for("update");

    if (!ledger || ledger.status !== "reserved") {
      return;
    }

    const bucketDate =
      typeof ledger.metadata.bucketDate === "string"
        ? ledger.metadata.bucketDate
        : reservation.bucketDate;
    const [bucket] = await tx
      .select()
      .from(dailyBudgetBuckets)
      .where(eq(dailyBudgetBuckets.bucketDate, bucketDate))
      .for("update");
    if (!bucket) {
      throw new QuotaError(
        QUOTA_ERROR_CODES.storageUnavailable,
        "全局预算存储暂不可用，请稍后重试。",
        503,
      );
    }

    const reservedMicros = usdStringToMicros(ledger.estimatedCostUsd);
    await tx
      .update(dailyBudgetBuckets)
      .set({
        reservedUsd: microsToUsdString(
          Math.max(0, usdStringToMicros(bucket.reservedUsd) - reservedMicros),
        ),
        updatedAt: new Date(),
      })
      .where(eq(dailyBudgetBuckets.id, bucket.id));
    await tx
      .update(usageLedger)
      .set({
        status: "released",
        metadata: {
          ...ledger.metadata,
          costEstimation: "released_before_provider_request",
        },
        updatedAt: new Date(),
      })
      .where(eq(usageLedger.id, ledger.id));
  });
}

/**
 * 未开启全局预算时保留旧账本入口，主要用于本地开发、历史数据恢复和兼容
 * 已有测试。它仍然是幂等写入，但不会虚构 Provider 价格。
 */
export async function recordModelUsage(input: {
  ownerId: string;
  agentRunId: string;
  provider: string;
  model: string;
  turn: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await recordUsageWithoutGlobalBudget({
    ownerId: input.ownerId,
    resource: "agent_run",
    agentRunId: input.agentRunId,
    provider: input.provider,
    model: input.model,
    idempotencyKey: `agent-turn:${input.agentRunId}:${input.turn}`,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    metadata: {
      turn: input.turn,
      costEstimation: "pending_price_table",
    },
  });
}

export async function recordImageUsage(input: {
  ownerId: string;
  imageRunId: string;
  provider: string;
  model: string;
  count: number;
  size: string;
  providerJobId?: string;
  attempt: number;
  status?: "settled" | "released";
}): Promise<void> {
  await recordUsageWithoutGlobalBudget({
    ownerId: input.ownerId,
    resource: "image_generation",
    imageRunId: input.imageRunId,
    provider: input.provider,
    model: input.model,
    idempotencyKey: `image-run:${input.imageRunId}`,
    metadata: {
      count: input.count,
      size: input.size,
      attempt: input.attempt,
      ...(input.providerJobId ? { providerJobId: input.providerJobId } : {}),
      costEstimation: "pending_price_table",
    },
    status: input.status ?? "settled",
  });
}

async function recordUsageWithoutGlobalBudget(input: {
  ownerId: string;
  resource: QuotaResource;
  agentRunId?: string;
  imageRunId?: string;
  provider: string;
  model: string;
  idempotencyKey: string;
  inputTokens?: number;
  outputTokens?: number;
  metadata: Record<string, unknown>;
  status?: "settled" | "released";
}): Promise<void> {
  await getDatabase()
    .insert(usageLedger)
    .values({
      ownerId: input.ownerId,
      resource: input.resource,
      agentRunId: input.agentRunId,
      imageRunId: input.imageRunId,
      provider: input.provider,
      model: input.model,
      status: input.status ?? "settled",
      idempotencyKey: input.idempotencyKey,
      inputTokens: Math.max(0, Math.floor(input.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.floor(input.outputTokens ?? 0)),
      estimatedCostUsd: "0",
      metadata: input.metadata,
      settledAt: input.status === "released" ? null : new Date(),
    })
    .onConflictDoNothing({ target: usageLedger.idempotencyKey });
}

function getModelPricingKind(provider: string): ModelPricingKind {
  return provider.trim().toLowerCase().includes("vision") ? "vision" : "llm";
}

function requireTokenPricing(kind: ModelPricingKind): {
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
} {
  const inputCostPerMillionUsd =
    kind === "vision"
      ? serverEnv.VISION_INPUT_COST_PER_1M_USD
      : serverEnv.LLM_INPUT_COST_PER_1M_USD;
  const outputCostPerMillionUsd =
    kind === "vision"
      ? serverEnv.VISION_OUTPUT_COST_PER_1M_USD
      : serverEnv.LLM_OUTPUT_COST_PER_1M_USD;

  if (
    inputCostPerMillionUsd === undefined ||
    outputCostPerMillionUsd === undefined
  ) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.globalBudgetPriceUnavailable,
      `全局预算已启用，但 ${kind} Provider 的 token 价格未配置。`,
      503,
      { pricingKind: kind },
    );
  }

  return { inputCostPerMillionUsd, outputCostPerMillionUsd };
}

function requireImagePrice(): number {
  const price = serverEnv.IMAGE_COST_PER_GENERATION_USD;
  if (price === undefined) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.globalBudgetPriceUnavailable,
      "全局预算已启用，但图片生成单价未配置。",
      503,
      { pricingKind: "image" },
    );
  }
  return price;
}

function estimateTokenCostMicros(input: {
  inputTokens: number;
  outputTokens: number;
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
}): number {
  return Math.max(
    0,
    Math.ceil(
      input.inputTokens * input.inputCostPerMillionUsd +
        input.outputTokens * input.outputCostPerMillionUsd,
    ),
  );
}

function getGlobalDailyBudgetLimitMicros(): number | null {
  const limit = serverEnv.MAX_GLOBAL_DAILY_COST_USD;
  if (limit === undefined) {
    return null;
  }
  return usdNumberToMicros(limit);
}

function usdNumberToMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.storageUnavailable,
      "全局预算金额配置不合法。",
      500,
    );
  }
  return Math.round(value * USD_SCALE);
}

function usdStringToMicros(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return usdNumberToMicros(value);
  }

  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.storageUnavailable,
      "预算账本中的金额格式不合法。",
      500,
    );
  }
  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * USD_SCALE + Number(fraction.padEnd(6, "0"));
}

function microsToUsdString(value: number): string {
  const normalized = Math.max(0, Math.round(value));
  const whole = Math.floor(normalized / USD_SCALE);
  const fraction = String(normalized % USD_SCALE).padStart(6, "0");
  return `${whole}.${fraction}`;
}

function createGlobalBudgetError(input: {
  bucketDate: string;
  limitMicros: number;
  usedMicros: number;
  requestedMicros: number;
}): QuotaError {
  return new QuotaError(
    QUOTA_ERROR_CODES.globalBudgetExhausted,
    "今日全站模型预算已用尽，请稍后再试。",
    429,
    {
      bucketDate: input.bucketDate,
      limitUsd: microsToUsdString(input.limitMicros),
      usedUsd: microsToUsdString(input.usedMicros),
      requestedUsd: microsToUsdString(input.requestedMicros),
    },
  );
}

function getQuotaPolicy(resource: QuotaResource): QuotaPolicy {
  const defaults = DEFAULT_POLICIES[resource];
  if (resource === "agent_run") {
    return {
      ...defaults,
      ipDailyLimit: serverEnv.ANON_RUNS_PER_IP_PER_DAY ?? defaults.ipDailyLimit,
      ownerDailyLimit:
        serverEnv.ANON_RUNS_PER_OWNER_PER_DAY ?? defaults.ownerDailyLimit,
      ownerConcurrentLimit:
        serverEnv.MAX_CONCURRENT_RUNS_PER_OWNER ??
        defaults.ownerConcurrentLimit,
      globalConcurrentLimit:
        serverEnv.MAX_GLOBAL_AGENT_RUNS ?? defaults.globalConcurrentLimit,
    };
  }
  if (resource === "image_generation") {
    return {
      ...defaults,
      ipDailyLimit:
        serverEnv.ANON_IMAGE_RUNS_PER_IP_PER_DAY ?? defaults.ipDailyLimit,
      ownerDailyLimit:
        serverEnv.ANON_IMAGE_RUNS_PER_OWNER_PER_DAY ?? defaults.ownerDailyLimit,
      ownerConcurrentLimit:
        serverEnv.MAX_CONCURRENT_IMAGE_RUNS_PER_OWNER ??
        defaults.ownerConcurrentLimit,
      globalConcurrentLimit:
        serverEnv.MAX_GLOBAL_IMAGE_RUNS ?? defaults.globalConcurrentLimit,
    };
  }
  return {
    ...defaults,
    ipDailyLimit:
      serverEnv.ANON_ATTACHMENTS_PER_IP_PER_DAY ?? defaults.ipDailyLimit,
    ownerDailyLimit:
      serverEnv.ANON_ATTACHMENTS_PER_OWNER_PER_DAY ?? defaults.ownerDailyLimit,
    ownerConcurrentLimit:
      serverEnv.MAX_CONCURRENT_UPLOADS_PER_OWNER ??
      defaults.ownerConcurrentLimit,
  };
}

async function countActiveLeases(
  tx: Parameters<Parameters<typeof runDatabaseTransaction>[0]>[0],
  input: { resource: QuotaResource; ownerId?: string; now: Date },
): Promise<number> {
  const subjectType = input.ownerId ? "owner" : "global";
  const rows = await tx
    .select({ id: quotaLeases.id })
    .from(quotaLeases)
    .where(
      and(
        eq(quotaLeases.resource, input.resource),
        input.ownerId ? eq(quotaLeases.ownerId, input.ownerId) : undefined,
        eq(quotaLeases.status, "active"),
        gt(quotaLeases.expiresAt, input.now),
        sql`${quotaLeases.metadata}->>'subjectType' = ${subjectType}`,
      ),
    );

  // owner 和 global scope 各自只统计对应 subjectType 的一条 lease。
  // 不再依赖“一次 reservation 恰好写两条记录”的实现细节。
  return rows.length;
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readRedisReservation(
  metadata: Record<string, unknown> | undefined,
): RedisRateLimitReservation | undefined {
  const candidate = metadata?.redisReservation;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  const value = candidate as Partial<RedisRateLimitReservation>;
  if (
    typeof value.leaseId !== "string" ||
    typeof value.resource !== "string" ||
    typeof value.ownerId !== "string" ||
    typeof value.units !== "number" ||
    typeof value.countTowardDailyQuota !== "boolean"
  ) {
    return undefined;
  }
  return {
    leaseId: value.leaseId,
    resource: value.resource,
    ownerId: value.ownerId,
    ipSubjectKey:
      typeof value.ipSubjectKey === "string" ? value.ipSubjectKey : undefined,
    // 旧租约没有 bucketDate 时保留 undefined，由限流层回退到当前日期。
    // 新租约会带上创建时的 UTC 日期，保证跨日释放仍命中原日桶。
    bucketDate:
      typeof value.bucketDate === "string" ? value.bucketDate : undefined,
    units: value.units,
    countTowardDailyQuota: value.countTowardDailyQuota,
  };
}

function normalizeQuotaUnits(units: number | undefined): number {
  const normalized = units ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new QuotaError(
      QUOTA_ERROR_CODES.storageUnavailable,
      "额度单位参数不合法。",
      500,
    );
  }
  return normalized;
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function hashClientIp(ip: string): string {
  const secret =
    serverEnv.ANON_SESSION_SECRET?.trim() || "webpilot-development-ip-salt";
  const date = getUtcDateKey();
  return createHmac("sha256", secret).update(`${date}:${ip}`).digest("hex");
}
