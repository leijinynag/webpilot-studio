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
import {
  FILE_TOOL_NAMES,
  FILE_TOOL_SCHEMAS,
  GIT_TOOL_NAMES,
  GIT_TOOL_SCHEMAS,
} from "@/domains/agent/tool-contracts";

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
    durationMs: z.number().int().nonnegative().max(300_000),
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

const clientToolRequestBase = {
  runId: z.uuid(),
  projectId: z.uuid(),
  toolCallId: z.string().min(1).max(500),
  idempotencyKey: z.string().min(1).max(1_000),
  revision: z.number().int().nonnegative(),
};

const repositoryToolFailureFields = {
  ok: z.literal(false),
  revision: z.number().int().nonnegative(),
  conflict: z.boolean(),
  error: z
    .object({
      code: z.string().min(1).max(200),
      message: z.string().min(1).max(2_048),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
};

function repositoryToolResultSchema<TToolName extends string>(
  toolName: TToolName,
) {
  return z.union([
    z
      .object({
        ok: z.literal(true),
        toolName: z.literal(toolName),
        revision: z.number().int().nonnegative(),
        data: z.record(z.string(), z.unknown()),
      })
      .strict(),
    z
      .object({
        ...repositoryToolFailureFields,
        toolName: z.literal(toolName),
      })
      .strict(),
  ]);
}

export const browserRepositoryToolResultSchema = z.union([
  repositoryToolResultSchema(FILE_TOOL_NAMES.listFiles),
  repositoryToolResultSchema(FILE_TOOL_NAMES.searchText),
  repositoryToolResultSchema(FILE_TOOL_NAMES.readFile),
  repositoryToolResultSchema(FILE_TOOL_NAMES.writeFile),
  repositoryToolResultSchema(FILE_TOOL_NAMES.deleteFile),
  repositoryToolResultSchema(FILE_TOOL_NAMES.renameFile),
  repositoryToolResultSchema(GIT_TOOL_NAMES.status),
  repositoryToolResultSchema(GIT_TOOL_NAMES.log),
  repositoryToolResultSchema(GIT_TOOL_NAMES.currentBranch),
  repositoryToolResultSchema(GIT_TOOL_NAMES.stage),
  repositoryToolResultSchema(GIT_TOOL_NAMES.unstage),
  repositoryToolResultSchema(GIT_TOOL_NAMES.commit),
]);

export type BrowserRepositoryToolResult = z.infer<
  typeof browserRepositoryToolResultSchema
>;

export const clientToolRequestSchema = z.discriminatedUnion("toolName", [
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(RUN_PREVIEW_TOOL_NAME),
      arguments: runPreviewToolArgumentsSchema,
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(BROWSER_VERIFY_TOOL_NAME),
      arguments: browserVerifyToolArgumentsSchema,
      verificationRunId: z.uuid(),
      source: z.enum(["agent", "replay"]),
      replayCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(FILE_TOOL_NAMES.listFiles),
      arguments: FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.listFiles],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(FILE_TOOL_NAMES.searchText),
      arguments: FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.searchText],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(FILE_TOOL_NAMES.readFile),
      arguments: FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.readFile],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(FILE_TOOL_NAMES.writeFile),
      arguments: FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.writeFile],
      readBeforeMutation: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(FILE_TOOL_NAMES.deleteFile),
      arguments: FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.deleteFile],
      readBeforeMutation: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(FILE_TOOL_NAMES.renameFile),
      arguments: FILE_TOOL_SCHEMAS[FILE_TOOL_NAMES.renameFile],
      readBeforeMutation: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(GIT_TOOL_NAMES.status),
      arguments: GIT_TOOL_SCHEMAS[GIT_TOOL_NAMES.status],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(GIT_TOOL_NAMES.log),
      arguments: GIT_TOOL_SCHEMAS[GIT_TOOL_NAMES.log],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(GIT_TOOL_NAMES.currentBranch),
      arguments: GIT_TOOL_SCHEMAS[GIT_TOOL_NAMES.currentBranch],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(GIT_TOOL_NAMES.stage),
      arguments: GIT_TOOL_SCHEMAS[GIT_TOOL_NAMES.stage],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(GIT_TOOL_NAMES.unstage),
      arguments: GIT_TOOL_SCHEMAS[GIT_TOOL_NAMES.unstage],
    })
    .strict(),
  z
    .object({
      ...clientToolRequestBase,
      toolName: z.literal(GIT_TOOL_NAMES.commit),
      arguments: GIT_TOOL_SCHEMAS[GIT_TOOL_NAMES.commit],
      author: z
        .object({
          name: z.string().trim().min(1).max(200),
          email: z.email().max(320),
        })
        .strict(),
    })
    .strict(),
]);

export type ClientToolRequest = z.infer<typeof clientToolRequestSchema>;

export type PreviewClientToolRequest = Extract<
  ClientToolRequest,
  {
    toolName: typeof RUN_PREVIEW_TOOL_NAME | typeof BROWSER_VERIFY_TOOL_NAME;
  }
>;

export type BrowserRepositoryClientToolRequest = Exclude<
  ClientToolRequest,
  PreviewClientToolRequest
>;

export function isPreviewClientToolRequest(
  request: ClientToolRequest | null | undefined,
): request is PreviewClientToolRequest {
  return (
    request?.toolName === RUN_PREVIEW_TOOL_NAME ||
    request?.toolName === BROWSER_VERIFY_TOOL_NAME
  );
}

export const clientToolResultSchema = z.union([
  runPreviewResultSchema,
  browserVerifyResultSchema,
  repositoryToolResultSchema(FILE_TOOL_NAMES.listFiles),
  repositoryToolResultSchema(FILE_TOOL_NAMES.searchText),
  repositoryToolResultSchema(FILE_TOOL_NAMES.readFile),
  repositoryToolResultSchema(FILE_TOOL_NAMES.writeFile),
  repositoryToolResultSchema(FILE_TOOL_NAMES.deleteFile),
  repositoryToolResultSchema(FILE_TOOL_NAMES.renameFile),
  repositoryToolResultSchema(GIT_TOOL_NAMES.status),
  repositoryToolResultSchema(GIT_TOOL_NAMES.log),
  repositoryToolResultSchema(GIT_TOOL_NAMES.currentBranch),
  repositoryToolResultSchema(GIT_TOOL_NAMES.stage),
  repositoryToolResultSchema(GIT_TOOL_NAMES.unstage),
  repositoryToolResultSchema(GIT_TOOL_NAMES.commit),
]);

export type ClientToolResult = z.infer<typeof clientToolResultSchema>;

export type PreviewClientToolResult = Extract<
  ClientToolResult,
  {
    toolName: typeof RUN_PREVIEW_TOOL_NAME | typeof BROWSER_VERIFY_TOOL_NAME;
  }
>;

export const clientToolResultRequestSchema = z.union([
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
  repositoryToolResultRequestSchema(FILE_TOOL_NAMES.listFiles),
  repositoryToolResultRequestSchema(FILE_TOOL_NAMES.searchText),
  repositoryToolResultRequestSchema(FILE_TOOL_NAMES.readFile),
  repositoryToolResultRequestSchema(FILE_TOOL_NAMES.writeFile),
  repositoryToolResultRequestSchema(FILE_TOOL_NAMES.deleteFile),
  repositoryToolResultRequestSchema(FILE_TOOL_NAMES.renameFile),
  repositoryToolResultRequestSchema(GIT_TOOL_NAMES.status),
  repositoryToolResultRequestSchema(GIT_TOOL_NAMES.log),
  repositoryToolResultRequestSchema(GIT_TOOL_NAMES.currentBranch),
  repositoryToolResultRequestSchema(GIT_TOOL_NAMES.stage),
  repositoryToolResultRequestSchema(GIT_TOOL_NAMES.unstage),
  repositoryToolResultRequestSchema(GIT_TOOL_NAMES.commit),
]);

export type ClientToolResultRequest = z.infer<
  typeof clientToolResultRequestSchema
>;

export type PreviewClientToolResultRequest = Extract<
  ClientToolResultRequest,
  {
    toolName: typeof RUN_PREVIEW_TOOL_NAME | typeof BROWSER_VERIFY_TOOL_NAME;
  }
>;

export type BrowserRepositoryClientToolResultRequest = Exclude<
  ClientToolResultRequest,
  PreviewClientToolResultRequest
>;

function repositoryToolResultRequestSchema<TToolName extends string>(
  toolName: TToolName,
) {
  return z
    .object({
      projectId: z.uuid(),
      toolCallId: z.string().min(1).max(500),
      toolName: z.literal(toolName),
      idempotencyKey: z.string().min(1).max(1_000),
      revision: z.number().int().nonnegative(),
      result: repositoryToolResultSchema(toolName),
    })
    .strict();
}
