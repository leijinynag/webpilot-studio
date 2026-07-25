import { describe, expect, it } from "vitest";

import { publicEnvSchema, serverEnvSchema } from "@/infrastructure/env/schema";

describe("environment schemas", () => {
  it("accepts an empty M0 environment", () => {
    expect(serverEnvSchema.parse({})).toEqual({});
    expect(publicEnvSchema.parse({})).toEqual({});
    expect(
      serverEnvSchema.parse({
        DATABASE_URL: "",
        AGENT_ENABLED: "",
        MAX_AGENT_MODEL_TURNS: "",
      }),
    ).toEqual({
      DATABASE_URL: undefined,
      AGENT_ENABLED: undefined,
      MAX_AGENT_MODEL_TURNS: undefined,
    });
  });

  it("coerces numeric limits and rejects malformed values", () => {
    expect(
      serverEnvSchema.parse({
        MAX_AGENT_MODEL_TURNS: "20",
        MAX_GLOBAL_DAILY_COST_USD: "0",
      }),
    ).toMatchObject({
      MAX_AGENT_MODEL_TURNS: 20,
      MAX_GLOBAL_DAILY_COST_USD: 0,
    });

    expect(() =>
      serverEnvSchema.parse({ MAX_CONCURRENT_RUNS_PER_OWNER: "many" }),
    ).toThrow();
  });

  it("keeps browser variables restricted to the public schema", () => {
    expect(() =>
      publicEnvSchema.parse({ LLM_API_KEY: "must-not-be-public" }),
    ).toThrow();
  });
});
