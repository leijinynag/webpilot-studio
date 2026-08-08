// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const redisState = vi.hoisted(() => ({
  eval: vi.fn(),
  instances: [] as Array<{ url: string; token: string }>,
}));

vi.mock("server-only", () => ({}));

vi.mock("@upstash/redis", () => ({
  Redis: class MockRedis {
    constructor(input: { url: string; token: string }) {
      redisState.instances.push(input);
    }

    eval(...args: unknown[]) {
      return redisState.eval(...args);
    }
  },
}));

import {
  isRedisRateLimitConfigured,
  RedisRateLimitRejectedError,
  RedisRateLimitStorageError,
  releaseRedisRateLimit,
  reserveRedisRateLimit,
} from "@/infrastructure/rate-limit/upstash-store";

const policy = {
  resource: "agent_run" as const,
  ownerId: "owner-1",
  ipSubjectKey: "ip-1",
  units: 1,
  countTowardDailyQuota: true,
  ownerDailyLimit: 10,
  ipDailyLimit: 5,
  ownerConcurrentLimit: 1,
  globalConcurrentLimit: 20,
  leaseMilliseconds: 60_000,
};

describe("Upstash Redis rate-limit store", () => {
  beforeEach(() => {
    redisState.eval.mockReset();
    redisState.instances.length = 0;
  });

  it("只有 URL 和 Token 同时存在时才认为 Redis 已配置", () => {
    expect(isRedisRateLimitConfigured({})).toBe(false);
    expect(
      isRedisRateLimitConfigured({
        url: "https://redis.example",
        token: "",
      }),
    ).toBe(false);
    expect(
      isRedisRateLimitConfigured({
        url: "https://redis.example",
        token: "token",
      }),
    ).toBe(true);
  });

  it("使用一次 Lua EVAL 原子创建并发、日额度和 reservation 元数据", async () => {
    redisState.eval.mockResolvedValue(["ok", "lease-1"]);

    const reservation = await reserveRedisRateLimit({
      redis: {
        url: "https://redis.example",
        token: "token-1",
      },
      policy,
    });

    expect(reservation).toMatchObject({
      leaseId: expect.any(String),
      resource: "agent_run",
      ownerId: "owner-1",
      ipSubjectKey: "ip-1",
      units: 1,
      countTowardDailyQuota: true,
    });
    expect(redisState.instances).toEqual([
      {
        url: "https://redis.example",
        token: "token-1",
      },
    ]);

    const [script, keys, args] = redisState.eval.mock.calls[0] as [
      string,
      string[],
      string[],
    ];
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("SET");
    expect(keys).toHaveLength(5);
    expect(args).toHaveLength(12);
    expect(args[3]).toBe("1");
    expect(args[8]).toBe("1");
    expect(args[9]).toBe("1");
  });

  it("把 Redis 的日额度和并发拒绝保留为可映射的领域错误", async () => {
    redisState.eval.mockResolvedValue(["reject", "daily", "ip", "3600"]);

    await expect(
      reserveRedisRateLimit({
        redis: {
          url: "https://redis.example",
          token: "token-2",
        },
        policy,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RedisRateLimitRejectedError>>({
        reason: "daily",
        scope: "ip",
        retryAfterSeconds: 3600,
      }),
    );
  });

  it("Redis 网络或脚本异常统一转成存储不可用错误", async () => {
    redisState.eval.mockRejectedValue(new Error("network down"));

    await expect(
      reserveRedisRateLimit({
        redis: {
          url: "https://redis.example",
          token: "token-3",
        },
        policy,
      }),
    ).rejects.toBeInstanceOf(RedisRateLimitStorageError);
  });

  it("释放脚本携带 refund 标志，重复释放交给 Lua 的 reservation key 幂等处理", async () => {
    redisState.eval.mockResolvedValue(1);

    await releaseRedisRateLimit({
      redis: {
        url: "https://redis.example",
        token: "token-4",
      },
      reservation: {
        leaseId: "lease-4",
        resource: "agent_run",
        ownerId: "owner-1",
        ipSubjectKey: "ip-1",
        bucketDate: "2026-08-08",
        units: 1,
        countTowardDailyQuota: true,
      },
      refundDailyQuota: false,
    });
    await releaseRedisRateLimit({
      redis: {
        url: "https://redis.example",
        token: "token-4",
      },
      reservation: {
        leaseId: "lease-4",
        resource: "agent_run",
        ownerId: "owner-1",
        ipSubjectKey: "ip-1",
        bucketDate: "2026-08-08",
        units: 1,
        countTowardDailyQuota: true,
      },
      refundDailyQuota: true,
    });

    expect(redisState.eval).toHaveBeenCalledTimes(2);
    expect((redisState.eval.mock.calls[0] as unknown[])[2]).toEqual([
      "lease-4",
      expect.any(String),
      "0",
    ]);
    expect((redisState.eval.mock.calls[1] as unknown[])[2]).toEqual([
      "lease-4",
      expect.any(String),
      "1",
    ]);
  });

  it("释放跨 UTC 零点的 reservation 时继续使用创建日期的日桶", async () => {
    redisState.eval
      .mockResolvedValueOnce(["ok", "lease-cross-day"])
      .mockResolvedValueOnce(1);

    const reservation = await reserveRedisRateLimit({
      redis: {
        url: "https://redis.example",
        token: "token-cross-day",
      },
      policy: {
        ...policy,
        bucketDate: "2026-08-07",
      },
    });

    expect(reservation.bucketDate).toBe("2026-08-07");
    await releaseRedisRateLimit({
      redis: {
        url: "https://redis.example",
        token: "token-cross-day",
      },
      reservation,
      refundDailyQuota: true,
    });

    const [releaseScript, releaseKeys, releaseArgs] = redisState.eval.mock
      .calls[1] as [string, string[], string[]];
    expect(releaseScript).toContain('redis.call("TTL", KEYS[3])');
    expect(releaseScript).toContain('redis.call("TTL", KEYS[4])');
    expect(releaseKeys[2]).toContain(":2026-08-07");
    expect(releaseKeys[3]).toContain(":2026-08-07");
    expect(releaseArgs).toEqual([reservation.leaseId, "0", "1"]);
  });

  it("Redis 配置切换时不会复用上一套连接", async () => {
    redisState.eval.mockResolvedValue(["ok", "lease"]);

    await reserveRedisRateLimit({
      redis: {
        url: "https://redis-a.example",
        token: "token-a",
      },
      policy,
    });
    await reserveRedisRateLimit({
      redis: {
        url: "https://redis-b.example",
        token: "token-b",
      },
      policy,
    });
    await reserveRedisRateLimit({
      redis: {
        url: "https://redis-b.example",
        token: "token-b",
      },
      policy,
    });

    expect(redisState.instances).toEqual([
      { url: "https://redis-a.example", token: "token-a" },
      { url: "https://redis-b.example", token: "token-b" },
    ]);
  });
});
