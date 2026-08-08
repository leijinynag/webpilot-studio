import "server-only";

import { randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";

export type RedisRateLimitPolicy = {
  resource: string;
  ownerId: string;
  ipSubjectKey?: string;
  /**
   * 创建 reservation 时固定使用的 UTC 日桶。
   *
   * 释放时必须继续定位到创建日期，避免任务跨过 UTC 零点后退错额度。
   */
  bucketDate?: string;
  units: number;
  countTowardDailyQuota: boolean;
  ownerDailyLimit: number;
  ipDailyLimit: number;
  ownerConcurrentLimit: number;
  globalConcurrentLimit: number;
  leaseMilliseconds: number;
};

export type RedisRateLimitReservation = {
  leaseId: string;
  resource: string;
  ownerId: string;
  ipSubjectKey?: string;
  bucketDate?: string;
  units: number;
  countTowardDailyQuota: boolean;
};

export class RedisRateLimitRejectedError extends Error {
  constructor(
    readonly reason: "daily" | "concurrent",
    readonly scope: "owner" | "ip" | "global",
    readonly retryAfterSeconds: number,
  ) {
    super(`Redis rate limit rejected: ${reason}/${scope}`);
    this.name = "RedisRateLimitRejectedError";
  }
}

export class RedisRateLimitStorageError extends Error {
  constructor(readonly cause: unknown) {
    super("Redis rate-limit storage is unavailable.");
    this.name = "RedisRateLimitStorageError";
  }
}

const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local units = tonumber(ARGV[4])
local ownerConcurrentLimit = tonumber(ARGV[5])
local globalConcurrentLimit = tonumber(ARGV[6])
local ownerDailyLimit = tonumber(ARGV[7])
local ipDailyLimit = tonumber(ARGV[8])
local countDaily = ARGV[9] == "1"
local hasIp = ARGV[10] == "1"
local ttlSeconds = tonumber(ARGV[11])
local dayTtlSeconds = tonumber(ARGV[12])

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)

if redis.call("ZCARD", KEYS[1]) >= ownerConcurrentLimit then
  return {"reject", "concurrent", "owner", "1"}
end
if redis.call("ZCARD", KEYS[2]) >= globalConcurrentLimit then
  return {"reject", "concurrent", "global", "1"}
end

if countDaily then
  local ownerUsed = tonumber(redis.call("GET", KEYS[3]) or "0")
  if ownerUsed + units > ownerDailyLimit then
    return {"reject", "daily", "owner", tostring(dayTtlSeconds)}
  end
  if hasIp then
    local ipUsed = tonumber(redis.call("GET", KEYS[4]) or "0")
    if ipUsed + units > ipDailyLimit then
      return {"reject", "daily", "ip", tostring(dayTtlSeconds)}
    end
  end
end

redis.call("ZADD", KEYS[1], expiresAt, leaseId)
redis.call("ZADD", KEYS[2], expiresAt, leaseId)
redis.call("EXPIRE", KEYS[1], ttlSeconds)
redis.call("EXPIRE", KEYS[2], ttlSeconds)

if countDaily then
  redis.call("INCRBY", KEYS[3], units)
  redis.call("EXPIRE", KEYS[3], dayTtlSeconds)
  if hasIp then
    redis.call("INCRBY", KEYS[4], units)
    redis.call("EXPIRE", KEYS[4], dayTtlSeconds)
  end
end

-- 记录本次 reservation 的释放信息。它的 TTL 覆盖整个自然日，
-- 这样即使并发 zset 先过期，后续数据库补偿仍然可以退回日计数。
redis.call("SET", KEYS[5], units .. ":" .. (countDaily and "1" or "0") .. ":" .. (hasIp and "1" or "0"), "EX", math.max(ttlSeconds, dayTtlSeconds))
return {"ok", leaseId}
`;

const RELEASE_SCRIPT = `
local lease = redis.call("GET", KEYS[5])
if not lease then
  return 0
end

local units, countDaily, hasIp = string.match(lease, "^(%d+):(%d+):(%d+)$")
units = tonumber(units)
countDaily = countDaily == "1"
hasIp = hasIp == "1"
local refundDaily = ARGV[3] == "1"

redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])

if countDaily and refundDaily then
  local ownerUsed = tonumber(redis.call("GET", KEYS[3]) or "0")
  local ownerTtl = redis.call("TTL", KEYS[3])
  if ownerTtl > 0 then
    redis.call("SET", KEYS[3], math.max(0, ownerUsed - units), "EX", ownerTtl)
  end
  if hasIp then
    local ipUsed = tonumber(redis.call("GET", KEYS[4]) or "0")
    local ipTtl = redis.call("TTL", KEYS[4])
    if ipTtl > 0 then
      redis.call("SET", KEYS[4], math.max(0, ipUsed - units), "EX", ipTtl)
    end
  end
end

redis.call("DEL", KEYS[5])
return 1
`;

let redisClient:
  | {
      cacheKey: string;
      client: Redis;
    }
  | undefined;

export function isRedisRateLimitConfigured(input: {
  url?: string;
  token?: string;
}): boolean {
  return Boolean(input.url?.trim() && input.token?.trim());
}

function getRedisClient(input: { url?: string; token?: string }): Redis {
  if (!isRedisRateLimitConfigured(input)) {
    throw new RedisRateLimitStorageError(
      new Error("REDIS_URL and REDIS_TOKEN are required."),
    );
  }
  const cacheKey = `${input.url}:${input.token}`;
  if (!redisClient || redisClient.cacheKey !== cacheKey) {
    redisClient = {
      cacheKey,
      client: new Redis({
        url: input.url!,
        token: input.token!,
      }),
    };
  }
  return redisClient.client;
}

function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function getSecondsUntilUtcTomorrow() {
  const now = Date.now();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((tomorrow.getTime() - now) / 1_000));
}

function buildKeys(policy: RedisRateLimitPolicy, leaseId: string) {
  const prefix = `webpilot:rate-limit:v1:${policy.resource}`;
  const date = policy.bucketDate ?? getDateKey();
  return [
    `${prefix}:concurrent:owner:${policy.ownerId}`,
    `${prefix}:concurrent:global`,
    `${prefix}:daily:owner:${policy.ownerId}:${date}`,
    `${prefix}:daily:ip:${policy.ipSubjectKey ?? "none"}:${date}`,
    `${prefix}:lease:${leaseId}`,
  ];
}

export async function reserveRedisRateLimit(input: {
  redis: { url?: string; token?: string };
  policy: RedisRateLimitPolicy;
}): Promise<RedisRateLimitReservation> {
  const leaseId = randomUUID();
  const now = Date.now();
  const expiresAt = now + input.policy.leaseMilliseconds;
  const ttlSeconds = Math.max(
    1,
    Math.ceil(input.policy.leaseMilliseconds / 1_000),
  );
  const dayTtlSeconds = getSecondsUntilUtcTomorrow();
  const bucketDate = input.policy.bucketDate ?? getDateKey();
  const hasIp = Boolean(input.policy.ipSubjectKey);
  const result = await getRedisClient(input.redis)
    .eval(ACQUIRE_SCRIPT, buildKeys(input.policy, leaseId), [
      String(now),
      String(expiresAt),
      leaseId,
      String(input.policy.units),
      String(input.policy.ownerConcurrentLimit),
      String(input.policy.globalConcurrentLimit),
      String(input.policy.ownerDailyLimit),
      String(input.policy.ipDailyLimit),
      input.policy.countTowardDailyQuota ? "1" : "0",
      hasIp ? "1" : "0",
      String(ttlSeconds),
      String(dayTtlSeconds),
    ])
    .catch((error: unknown) => {
      throw new RedisRateLimitStorageError(error);
    });

  if (
    !Array.isArray(result) ||
    result.some((item) => typeof item !== "string")
  ) {
    throw new RedisRateLimitStorageError(
      new Error("Redis rate-limit script returned an invalid result."),
    );
  }

  if (result[0] === "reject") {
    throw new RedisRateLimitRejectedError(
      result[1] as "daily" | "concurrent",
      result[2] as "owner" | "ip" | "global",
      Number(result[3]) || 1,
    );
  }

  return {
    leaseId,
    resource: input.policy.resource,
    ownerId: input.policy.ownerId,
    ipSubjectKey: input.policy.ipSubjectKey,
    bucketDate,
    units: input.policy.units,
    countTowardDailyQuota: input.policy.countTowardDailyQuota,
  };
}

export async function releaseRedisRateLimit(input: {
  redis: { url?: string; token?: string };
  reservation: RedisRateLimitReservation;
  refundDailyQuota: boolean;
}): Promise<void> {
  await getRedisClient(input.redis)
    .eval(
      RELEASE_SCRIPT,
      buildKeys(
        {
          resource: input.reservation.resource,
          ownerId: input.reservation.ownerId,
          ipSubjectKey: input.reservation.ipSubjectKey,
          bucketDate: input.reservation.bucketDate,
          units: input.reservation.units,
          countTowardDailyQuota: input.reservation.countTowardDailyQuota,
          ownerDailyLimit: 0,
          ipDailyLimit: 0,
          ownerConcurrentLimit: 0,
          globalConcurrentLimit: 0,
          leaseMilliseconds: 0,
        },
        input.reservation.leaseId,
      ),
      [input.reservation.leaseId, "0", input.refundDailyQuota ? "1" : "0"],
    )
    .catch((error: unknown) => {
      throw new RedisRateLimitStorageError(error);
    });
}
