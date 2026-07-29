import { z } from "zod";

import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_VERSION,
} from "@/domains/agent/evidence";

export const BROWSER_BRIDGE_REQUEST_TYPE = "WEBPILOT_BROWSER_REQUEST";
export const BROWSER_BRIDGE_RESPONSE_TYPE = "WEBPILOT_BROWSER_RESPONSE";

export const MAX_DOM_EVIDENCE_NODES = 60;
export const MAX_DOM_EVIDENCE_BYTES = 16 * 1024;
export const MAX_BROWSER_STEPS = 20;
export const MAX_NETWORK_ENTRIES = 30;
export const MAX_NETWORK_TOTAL_BYTES = 16 * 1024;

const timestampSchema = z.number().int().nonnegative();
const timeoutSchema = z.number().int().min(100).max(5_000);

/**
 * Target 是宿主与 Preview iframe 之间的稳定契约。策略顺序由扫描器决定，
 * 执行器仍会严格检查唯一性，绝不在歧义目标中静默选择第一个元素。
 */
export const browserTargetSchema = z.discriminatedUnion("strategy", [
  z
    .object({
      strategy: z.literal("test_id"),
      value: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("role_name"),
      role: z.string().min(1).max(64),
      name: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("css"),
      selector: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      strategy: z.literal("scan_id"),
      id: z.string().min(1).max(100),
    })
    .strict(),
]);

export type BrowserTarget = z.infer<typeof browserTargetSchema>;

export const domNodeEvidenceSchema = z
  .object({
    scanId: z.string().min(1).max(100),
    tag: z.string().min(1).max(64),
    role: z.string().max(64).nullable(),
    name: z.string().max(500).nullable(),
    text: z.string().max(500).nullable(),
    testId: z.string().max(256).nullable(),
    inputType: z.string().max(64).nullable(),
    href: z.string().max(1_000).nullable(),
    visible: z.boolean(),
    disabled: z.boolean(),
    target: browserTargetSchema,
  })
  .strict();

export const domEvidenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(200),
    nodes: z.array(domNodeEvidenceSchema).max(MAX_DOM_EVIDENCE_NODES),
    summary: z.string().max(MAX_DOM_EVIDENCE_BYTES),
    totalBytes: z.number().int().min(0).max(MAX_DOM_EVIDENCE_BYTES),
    truncated: z.boolean(),
  })
  .strict();

export type DomEvidence = z.infer<typeof domEvidenceSchema>;

const targetTimeoutFields = {
  target: browserTargetSchema,
  timeoutMs: timeoutSchema.optional(),
};

export const browserStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ...targetTimeoutFields }).strict(),
  z
    .object({
      action: z.literal("fill"),
      ...targetTimeoutFields,
      value: z.string().max(8_192),
    })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      ...targetTimeoutFields,
      value: z.string().max(2_048),
    })
    .strict(),
  z
    .object({
      action: z.literal("press"),
      target: browserTargetSchema.optional(),
      key: z.string().min(1).max(100),
      timeoutMs: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("wait_for"),
      target: browserTargetSchema.optional(),
      timeoutMs: timeoutSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("assert_text"),
      target: browserTargetSchema.optional(),
      text: z.string().max(2_048),
      timeoutMs: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("assert_visible"),
      ...targetTimeoutFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("assert_url"),
      pattern: z.string().min(1).max(2_048),
      timeoutMs: timeoutSchema.optional(),
    })
    .strict(),
]);

export type BrowserStep = z.infer<typeof browserStepSchema>;

export const browserStepErrorSchema = z
  .object({
    code: z.enum([
      "invalid_command",
      "target_not_found",
      "target_ambiguous",
      "target_not_visible",
      "unsupported_element",
      "option_not_found",
      "assertion_failed",
      "timeout",
      "action_failed",
    ]),
    message: z.string().min(1).max(2_048),
  })
  .strict();

export type BrowserStepError = z.infer<typeof browserStepErrorSchema>;

const browserActionSchema = z.enum([
  "click",
  "fill",
  "select",
  "press",
  "wait_for",
  "assert_text",
  "assert_visible",
  "assert_url",
]);

export const browserStepResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    action: browserActionSchema,
    startedAt: timestampSchema,
    durationMs: z.number().int().nonnegative().max(60_000),
    target: browserTargetSchema.nullable(),
    status: z.enum(["passed", "failed"]),
    message: z.string().max(2_048),
    error: browserStepErrorSchema.nullable(),
  })
  .strict();

export const browserExecutionEvidenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(200),
    ok: z.boolean(),
    steps: z.array(browserStepResultSchema).max(MAX_BROWSER_STEPS),
    failedStep: z.number().int().nonnegative().nullable(),
    domContext: domEvidenceSchema.nullable(),
  })
  .strict();

export type BrowserExecutionEvidence = z.infer<
  typeof browserExecutionEvidenceSchema
>;

export const sanitizedNetworkUrlSchema = z
  .object({
    origin: z.string().max(500),
    path: z.string().max(1_000),
    queryKeys: z.array(z.string().max(200)).max(20),
  })
  .strict();

export const networkEntrySchema = z
  .object({
    requestType: z.enum(["fetch", "xhr"]),
    method: z.string().min(1).max(20),
    status: z.number().int().min(0).max(999).nullable(),
    durationMs: z.number().int().nonnegative().max(300_000),
    timestamp: timestampSchema,
    url: sanitizedNetworkUrlSchema,
    failed: z.boolean(),
    error: z.string().max(1_000).nullable(),
  })
  .strict();

export type NetworkEntry = z.infer<typeof networkEntrySchema>;

export const networkEvidenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(200),
    entries: z.array(networkEntrySchema).max(MAX_NETWORK_ENTRIES),
    totalBytes: z.number().int().min(0).max(MAX_NETWORK_TOTAL_BYTES),
    truncated: z.boolean(),
    includesSuccessful: z.boolean(),
  })
  .strict();

export type NetworkEvidence = z.infer<typeof networkEvidenceSchema>;

export const browserCommandSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("start_session") }).strict(),
  z.object({ name: z.literal("scan_dom") }).strict(),
  z
    .object({
      name: z.literal("execute_steps"),
      steps: z.array(browserStepSchema).min(1).max(MAX_BROWSER_STEPS),
    })
    .strict(),
  z
    .object({
      name: z.literal("get_network"),
      includeSuccessful: z.boolean().optional(),
    })
    .strict(),
  z.object({ name: z.literal("end_session") }).strict(),
]);

export type BrowserCommand = z.infer<typeof browserCommandSchema>;

export const browserBridgeRequestSchema = z
  .object({
    channel: z.literal(RUNTIME_BRIDGE_CHANNEL),
    version: z.literal(RUNTIME_BRIDGE_VERSION),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    type: z.literal(BROWSER_BRIDGE_REQUEST_TYPE),
    requestId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    command: browserCommandSchema,
  })
  .strict();

export type BrowserBridgeRequest = z.infer<typeof browserBridgeRequestSchema>;

const browserResponseErrorSchema = z
  .object({
    code: z.enum(["invalid_command", "session_inactive", "execution_failed"]),
    message: z.string().min(1).max(2_048),
  })
  .strict();

const browserResponsePayloadSchema = z.union([
  z
    .object({
      commandName: z.literal("start_session"),
      ok: z.literal(true),
      result: z.object({ started: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      commandName: z.literal("scan_dom"),
      ok: z.literal(true),
      result: domEvidenceSchema,
    })
    .strict(),
  z
    .object({
      commandName: z.literal("execute_steps"),
      ok: z.literal(true),
      result: browserExecutionEvidenceSchema,
    })
    .strict(),
  z
    .object({
      commandName: z.literal("get_network"),
      ok: z.literal(true),
      result: networkEvidenceSchema,
    })
    .strict(),
  z
    .object({
      commandName: z.literal("end_session"),
      ok: z.literal(true),
      result: z.object({ ended: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      commandName: z.enum([
        "start_session",
        "scan_dom",
        "execute_steps",
        "get_network",
        "end_session",
      ]),
      ok: z.literal(false),
      error: browserResponseErrorSchema,
    })
    .strict(),
]);

/**
 * Browser Response 与 Runtime Evidence 分开校验。前者是一次请求的应答，
 * 后者是观察窗口中的事实流，分离后 4.4 可以独立处理超时、幂等和迟到响应。
 */
export const browserBridgeResponseSchema = z
  .object({
    channel: z.literal(RUNTIME_BRIDGE_CHANNEL),
    version: z.literal(RUNTIME_BRIDGE_VERSION),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    type: z.literal(BROWSER_BRIDGE_RESPONSE_TYPE),
    requestId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    payload: browserResponsePayloadSchema,
  })
  .strict();

export type BrowserBridgeResponse = z.infer<typeof browserBridgeResponseSchema>;
