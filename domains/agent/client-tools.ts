import { z } from "zod";

import {
  browserExecutionEvidenceSchema,
  browserStepSchema,
  networkEvidenceSchema,
} from "@/domains/agent/browser-evidence";
import {
  buildEvidenceSchema,
  consoleEvidenceSchema,
  RUN_PREVIEW_TOOL_NAME,
  runPreviewResultSchema,
  runPreviewToolArgumentsSchema,
  runtimeEvidenceSchema,
} from "@/domains/agent/evidence";

export const BROWSER_VERIFY_TOOL_NAME = "browser_verify";

const acceptedNetworkFailureSchema = z
  .object({
    method: z.string().min(1).max(20).optional(),
    origin: z.string().max(500).optional(),
    path: z.string().min(1).max(1_000),
    statuses: z.array(z.number().int().min(0).max(999)).max(20).optional(),
  })
  .strict();

export type AcceptedNetworkFailure = z.infer<
  typeof acceptedNetworkFailureSchema
>;

const assertionActions = new Set([
  "assert_text",
  "assert_visible",
  "assert_url",
]);

/**
 * smoke plan 必须至少包含一个断言。只有动作而没有可观察结果时，
 * 即使 click/fill 没抛异常，也不能证明用户流程真的完成。
 */
export const browserVerifyToolArgumentsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    steps: z.array(browserStepSchema).min(1).max(20),
    acceptedNetworkFailures: z
      .array(acceptedNetworkFailureSchema)
      .max(20)
      .default([]),
    observationMs: z.number().int().min(500).max(10_000).default(1_500),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.steps.some((step) => assertionActions.has(step.action))) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "browser_verify 至少需要一个 assertion step。",
      });
    }
  });

export type BrowserVerifyToolArguments = z.infer<
  typeof browserVerifyToolArgumentsSchema
>;

export const browserVerificationChecksSchema = z
  .object({
    build: z.boolean(),
    runtime: z.boolean(),
    console: z.boolean(),
    network: z.boolean(),
    actions: z.boolean(),
    assertions: z.boolean(),
    revision: z.boolean(),
  })
  .strict();

export type BrowserVerificationChecks = z.infer<
  typeof browserVerificationChecksSchema
>;

/**
 * 客户端返回完整原始证据，但 ok/checks/summary 只用于传输和即时展示。
 * Store 在事务内会根据原始 Evidence 与当前 Run revision 重新计算这些字段，
 * 因而客户端不能自行把失败结果标记为 verified。
 */
export const browserVerifyResultSchema = z
  .object({
    ok: z.boolean(),
    toolName: z.literal(BROWSER_VERIFY_TOOL_NAME),
    verificationRunId: z.uuid(),
    revision: z.number().int().nonnegative(),
    replayCount: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_048),
    build: buildEvidenceSchema,
    runtime: runtimeEvidenceSchema,
    console: consoleEvidenceSchema,
    browser: browserExecutionEvidenceSchema,
    network: networkEvidenceSchema,
    acceptedNetworkFailures: z
      .array(acceptedNetworkFailureSchema)
      .max(20)
      .default([]),
    checks: browserVerificationChecksSchema,
  })
  .strict();

export type BrowserVerifyResult = z.infer<typeof browserVerifyResultSchema>;

export const clientToolRequestSchema = z.discriminatedUnion("toolName", [
  z
    .object({
      runId: z.uuid(),
      projectId: z.uuid(),
      toolCallId: z.string().min(1).max(500),
      toolName: z.literal(RUN_PREVIEW_TOOL_NAME),
      idempotencyKey: z.string().min(1).max(1_000),
      revision: z.number().int().nonnegative(),
      arguments: runPreviewToolArgumentsSchema,
    })
    .strict(),
  z
    .object({
      runId: z.uuid(),
      projectId: z.uuid(),
      toolCallId: z.string().min(1).max(500),
      toolName: z.literal(BROWSER_VERIFY_TOOL_NAME),
      idempotencyKey: z.string().min(1).max(1_000),
      revision: z.number().int().nonnegative(),
      arguments: browserVerifyToolArgumentsSchema,
      verificationRunId: z.uuid(),
      source: z.enum(["agent", "replay"]),
      replayCount: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type ClientToolRequest = z.infer<typeof clientToolRequestSchema>;

export const clientToolResultSchema = z.discriminatedUnion("toolName", [
  runPreviewResultSchema,
  browserVerifyResultSchema,
]);

export type ClientToolResult = z.infer<typeof clientToolResultSchema>;

export const clientToolResultRequestSchema = z.discriminatedUnion("toolName", [
  z
    .object({
      projectId: z.uuid(),
      toolCallId: z.string().min(1).max(500),
      toolName: z.literal(RUN_PREVIEW_TOOL_NAME),
      idempotencyKey: z.string().min(1).max(1_000),
      revision: z.number().int().nonnegative(),
      result: runPreviewResultSchema,
    })
    .strict(),
  z
    .object({
      projectId: z.uuid(),
      toolCallId: z.string().min(1).max(500),
      toolName: z.literal(BROWSER_VERIFY_TOOL_NAME),
      idempotencyKey: z.string().min(1).max(1_000),
      revision: z.number().int().nonnegative(),
      result: browserVerifyResultSchema,
    })
    .strict(),
]);

export type ClientToolResultRequest = z.infer<
  typeof clientToolResultRequestSchema
>;
