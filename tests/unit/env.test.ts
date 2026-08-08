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
        MAX_AGENT_FILE_MUTATIONS: "",
        VISION_TIMEOUT_MS: "",
      }),
    ).toEqual({
      DATABASE_URL: undefined,
      AGENT_ENABLED: undefined,
      MAX_AGENT_MODEL_TURNS: undefined,
      MAX_AGENT_FILE_MUTATIONS: undefined,
      VISION_TIMEOUT_MS: undefined,
    });
  });

  it("coerces numeric limits and rejects malformed values", () => {
    expect(
      serverEnvSchema.parse({
        MAX_AGENT_MODEL_TURNS: "20",
        MAX_AGENT_FILE_MUTATIONS: "512",
        VISION_TIMEOUT_MS: "60000",
        MAX_GLOBAL_DAILY_COST_USD: "0",
      }),
    ).toMatchObject({
      MAX_AGENT_MODEL_TURNS: 20,
      MAX_AGENT_FILE_MUTATIONS: 512,
      VISION_TIMEOUT_MS: 60000,
      MAX_GLOBAL_DAILY_COST_USD: 0,
    });

    expect(() =>
      serverEnvSchema.parse({ MAX_CONCURRENT_RUNS_PER_OWNER: "many" }),
    ).toThrow();
    expect(() =>
      serverEnvSchema.parse({ MAX_AGENT_FILE_MUTATIONS: "many" }),
    ).toThrow();
  });

  it("keeps browser variables restricted to the public schema", () => {
    expect(() =>
      publicEnvSchema.parse({ LLM_API_KEY: "must-not-be-public" }),
    ).toThrow();
  });
});
