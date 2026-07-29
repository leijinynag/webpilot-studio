import { z } from "zod";

export const RUNTIME_BRIDGE_CHANNEL = "webpilot-preview-runtime";
export const RUNTIME_BRIDGE_VERSION = 1;
export const RUNTIME_BRIDGE_PROBE_TYPE = "WEBPILOT_RUNTIME_PROBE";
export const RUN_PREVIEW_TOOL_NAME = "run_preview";

export const MAX_CONSOLE_ENTRY_BYTES = 2 * 1024;
export const MAX_CONSOLE_ENTRIES = 50;
export const MAX_CONSOLE_TOTAL_BYTES = 16 * 1024;

const timestampSchema = z.number().int().nonnegative();
const boundedTextSchema = z.string().max(8_192);

const renderOkEnvelopeSchema = z
  .object({
    channel: z.literal(RUNTIME_BRIDGE_CHANNEL),
    version: z.literal(RUNTIME_BRIDGE_VERSION),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    type: z.literal("RENDER_OK"),
    payload: z
      .object({
        timestamp: timestampSchema,
      })
      .strict(),
  })
  .strict();

const runtimeErrorPayloadSchema = z
  .object({
    message: z.string().min(1).max(2_048),
    stack: boundedTextSchema.optional(),
    timestamp: timestampSchema,
  })
  .strict();

const runtimeErrorEnvelopeSchema = z
  .object({
    channel: z.literal(RUNTIME_BRIDGE_CHANNEL),
    version: z.literal(RUNTIME_BRIDGE_VERSION),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    type: z.enum(["RUNTIME_ERROR", "UNHANDLED_REJECTION"]),
    payload: runtimeErrorPayloadSchema,
  })
  .strict();

const consoleEnvelopeSchema = z
  .object({
    channel: z.literal(RUNTIME_BRIDGE_CHANNEL),
    version: z.literal(RUNTIME_BRIDGE_VERSION),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    type: z.enum(["CONSOLE_WARN", "CONSOLE_ERROR"]),
    payload: z
      .object({
        arguments: z.array(z.string().max(MAX_CONSOLE_ENTRY_BYTES)).max(20),
        timestamp: timestampSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Preview 页面发出的消息必须完整匹配已知协议。这里不保留 catch-all 分支，
 * 未知 type、额外字段或版本漂移都会被父窗口拒绝，避免把任意 iframe 消息
 * 当作 Agent 证据。
 */
export const runtimeEnvelopeSchema = z.discriminatedUnion("type", [
  renderOkEnvelopeSchema,
  runtimeErrorEnvelopeSchema,
  consoleEnvelopeSchema,
]);

export type RuntimeEnvelope = z.infer<typeof runtimeEnvelopeSchema>;

/**
 * 宿主页面通过定向 postMessage 主动探测 Bridge。该协议与 iframe 回传协议
 * 分开建模，避免把宿主命令误当成 Evidence，同时允许页面刷新后重新确认首帧。
 */
export const runtimeProbeSchema = z
  .object({
    channel: z.literal(RUNTIME_BRIDGE_CHANNEL),
    version: z.literal(RUNTIME_BRIDGE_VERSION),
    runId: z.uuid(),
    revision: z.number().int().nonnegative(),
    type: z.literal(RUNTIME_BRIDGE_PROBE_TYPE),
  })
  .strict();

export type RuntimeProbe = z.infer<typeof runtimeProbeSchema>;

export const runtimeBridgeDiagnosticSchema = z
  .object({
    code: z.enum([
      "invalid_source",
      "invalid_origin",
      "invalid_envelope",
      "unknown_run",
      "stale_revision",
    ]),
    message: z.string().max(500),
    timestamp: timestampSchema,
  })
  .strict();

export type RuntimeBridgeDiagnostic = z.infer<
  typeof runtimeBridgeDiagnosticSchema
>;

export const buildEvidenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    install: z
      .object({
        status: z.enum(["not_started", "succeeded", "failed"]),
        exitCode: z.number().int().nullable(),
      })
      .strict(),
    devServer: z
      .object({
        status: z.enum(["not_started", "ready", "failed"]),
        port: z.number().int().positive().nullable(),
        url: z.string().url().nullable(),
      })
      .strict(),
    errors: z.array(boundedTextSchema).max(50),
    logs: z.array(z.string().max(2_048)).max(80),
  })
  .strict();

export const runtimeEvidenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    rendered: z.boolean(),
    events: z
      .array(
        z
          .object({
            type: z.enum(["RENDER_OK", "RUNTIME_ERROR", "UNHANDLED_REJECTION"]),
            message: z.string().max(2_048).optional(),
            stack: boundedTextSchema.optional(),
            timestamp: timestampSchema,
          })
          .strict(),
      )
      .max(50),
    diagnostics: z.array(runtimeBridgeDiagnosticSchema).max(50),
  })
  .strict();

export const consoleEvidenceSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    entries: z
      .array(
        z
          .object({
            level: z.enum(["warn", "error"]),
            arguments: z.array(z.string().max(MAX_CONSOLE_ENTRY_BYTES)).max(20),
            timestamp: timestampSchema,
          })
          .strict(),
      )
      .max(MAX_CONSOLE_ENTRIES),
    totalBytes: z.number().int().min(0).max(MAX_CONSOLE_TOTAL_BYTES),
    truncated: z.boolean(),
  })
  .strict();

export const runPreviewResultSchema = z
  .object({
    ok: z.boolean(),
    toolName: z.literal(RUN_PREVIEW_TOOL_NAME),
    revision: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_048),
    build: buildEvidenceSchema,
    runtime: runtimeEvidenceSchema,
    console: consoleEvidenceSchema,
  })
  .strict();

export type BuildEvidence = z.infer<typeof buildEvidenceSchema>;
export type RuntimeEvidence = z.infer<typeof runtimeEvidenceSchema>;
export type ConsoleEvidence = z.infer<typeof consoleEvidenceSchema>;
export type RunPreviewResult = z.infer<typeof runPreviewResultSchema>;

export const runPreviewToolArgumentsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    observationMs: z.number().int().min(500).max(10_000).default(1_500),
  })
  .strict();

export type RunPreviewToolArguments = z.infer<
  typeof runPreviewToolArgumentsSchema
>;
