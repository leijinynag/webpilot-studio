import { z } from "zod";

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);
const optionalUrl = z.preprocess(emptyStringToUndefined, z.url().optional());
const optionalBoolean = z.preprocess(
  emptyStringToUndefined,
  z.enum(["true", "false"]).optional(),
);
const optionalPositiveInteger = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().positive().optional(),
);
const optionalNonNegativeNumber = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().nonnegative().optional(),
);

export const publicEnvSchema = z
  .object({
    NEXT_PUBLIC_SITE_URL: optionalUrl,
  })
  .strict();

export const serverEnvSchema = z
  .object({
    DATABASE_URL: optionalUrl,
    BLOB_READ_WRITE_TOKEN: optionalString,
    ANON_SESSION_SECRET: optionalString,
    LLM_PROVIDER: optionalString,
    LLM_BASE_URL: optionalUrl,
    LLM_API_KEY: optionalString,
    LLM_AGENT_MODEL: optionalString,
    LLM_FAST_MODEL: optionalString,
    VISION_PROVIDER: optionalString,
    VISION_BASE_URL: optionalUrl,
    VISION_API_KEY: optionalString,
    VISION_MODEL: optionalString,
    IMAGE_PROVIDER: optionalString,
    IMAGE_BASE_URL: optionalUrl,
    IMAGE_API_KEY: optionalString,
    IMAGE_MODEL: optionalString,
    QUEUE_URL: optionalUrl,
    QUEUE_TOKEN: optionalString,
    REDIS_URL: optionalUrl,
    REDIS_TOKEN: optionalString,
    SHOWCASE_ADMIN_TOKEN: optionalString,
    SHOWCASE_ORIGIN: optionalUrl,
    SHOWCASE_PARENT_ORIGIN: optionalUrl,
    SHOWCASE_RUNTIME_ONLY: optionalBoolean,
    AGENT_ENABLED: optionalBoolean,
    IMAGE_GENERATION_ENABLED: optionalBoolean,
    ATTACHMENT_UPLOAD_ENABLED: optionalBoolean,
    ANON_RUNS_PER_IP_PER_DAY: optionalPositiveInteger,
    ANON_RUNS_PER_OWNER_PER_DAY: optionalPositiveInteger,
    MAX_CONCURRENT_RUNS_PER_OWNER: optionalPositiveInteger,
    MAX_GLOBAL_AGENT_RUNS: optionalPositiveInteger,
    MAX_AGENT_MODEL_TURNS: optionalPositiveInteger,
    MAX_AGENT_WALL_TIME_SECONDS: optionalPositiveInteger,
    MAX_GLOBAL_DAILY_COST_USD: optionalNonNegativeNumber,
  })
  .strict();

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
