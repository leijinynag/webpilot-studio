// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

// agent-api 还会导入数据库持久化工厂，而数据库入口通过 server-only
// 防止被客户端组件误用。这里测试的是纯 HTTP 响应契约，因此显式替换
// 该边界标记，避免单元测试加载模块时被与目标无关的运行时保护中断。
vi.mock("server-only", () => ({}));

import { agentJsonResponse } from "@/infrastructure/http/agent-api";

describe("Agent API response", () => {
  it("为动态 Agent 数据同时设置关联 ID 与禁止缓存策略", async () => {
    const correlationId = "44444444-4444-4444-8444-444444444444";
    const response = agentJsonResponse({ status: "succeeded" }, correlationId, {
      status: 201,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    await expect(response.json()).resolves.toEqual({ status: "succeeded" });
  });
});
