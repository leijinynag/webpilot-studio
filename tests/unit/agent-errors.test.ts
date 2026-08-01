import { describe, expect, it } from "vitest";

import {
  AGENT_ERROR_CODES,
  AgentError,
  serializeAgentError,
} from "@/domains/agent/errors";

describe("Agent error logging", () => {
  it("提取普通 Error 的不可枚举诊断字段", () => {
    const error = Object.assign(new Error("database connection interrupted"), {
      code: "57P01",
      severity: "FATAL",
      constraint: "agent_runs_project_active_uidx",
    });

    expect(serializeAgentError(error)).toMatchObject({
      name: "Error",
      message: "database connection interrupted",
      databaseCode: "57P01",
      severity: "FATAL",
      constraint: "agent_runs_project_active_uidx",
      stack: expect.stringContaining("database connection interrupted"),
    });
  });

  it("保留 AgentError 的领域代码和 details", () => {
    const error = new AgentError(
      AGENT_ERROR_CODES.runConflict,
      "执行租约已失效。",
      409,
      { leaseId: "lease-1" },
    );

    expect(serializeAgentError(error)).toMatchObject({
      name: "AgentError",
      message: "执行租约已失效。",
      agentCode: AGENT_ERROR_CODES.runConflict,
      status: 409,
      details: { leaseId: "lease-1" },
    });
  });

  it("递归展开 Drizzle 包装的数据库 cause、SQL 与参数", () => {
    const cause = Object.assign(new Error("WebSocket connection closed"), {
      code: "ECONNRESET",
      severity: "FATAL",
    });
    const error = Object.assign(
      new Error("Failed query: insert into agent_run_events"),
      {
        cause,
        query: "insert into agent_run_events (run_id, type) values ($1, $2)",
        params: ["run-1", "assistant.delta"],
      },
    );

    expect(serializeAgentError(error)).toMatchObject({
      message: "Failed query: insert into agent_run_events",
      query: "insert into agent_run_events (run_id, type) values ($1, $2)",
      params: ["run-1", "assistant.delta"],
      cause: {
        message: "WebSocket connection closed",
        databaseCode: "ECONNRESET",
        severity: "FATAL",
      },
    });
  });

  it("限制 cause 深度，避免循环或异常链无限展开", () => {
    const deepest = new Error("level-4");
    const levelThree = Object.assign(new Error("level-3"), { cause: deepest });
    const levelTwo = Object.assign(new Error("level-2"), {
      cause: levelThree,
    });
    const levelOne = Object.assign(new Error("level-1"), { cause: levelTwo });
    const root = Object.assign(new Error("root"), { cause: levelOne });

    expect(serializeAgentError(root)).toMatchObject({
      cause: {
        message: "level-1",
        cause: {
          message: "level-2",
          cause: {
            message: "level-3",
          },
        },
      },
    });
    expect(
      (
        (
          (serializeAgentError(root).cause as Record<string, unknown>)
            .cause as Record<string, unknown>
        ).cause as Record<string, unknown>
      ).cause,
    ).toBeUndefined();
  });

  it("非 Error 抛出值仍能被日志记录", () => {
    expect(serializeAgentError({ reason: "unknown" })).toEqual({
      value: { reason: "unknown" },
    });
  });
});
