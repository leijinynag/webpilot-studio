import { z } from "zod";

import type {
  RunPreviewResult,
  RuntimeEvidence,
} from "@/domains/agent/evidence";
import type { AgentRunRecord, TranscriptMessage } from "@/domains/agent/types";

const verificationIssueSchema = z
  .object({
    source: z.enum(["install", "dev_server", "build", "runtime", "console"]),
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(2_048),
    stack: z.string().max(8_192).optional(),
  })
  .strict();

/**
 * Preview 失败不能只留一段供人阅读的 summary。这个结构会进入 Transcript、
 * SSE 事件和下一轮模型上下文，保证修复循环始终围绕同一份可比较证据推进。
 */
export const verificationFailureSchema = z
  .object({
    kind: z.literal("verification_failure"),
    code: z.enum([
      "install_failed",
      "dev_server_failed",
      "build_failed",
      "runtime_error",
      "unhandled_rejection",
      "console_error",
      "render_failed",
      "preview_failed",
    ]),
    stage: z.enum(["install", "dev_server", "build", "runtime", "console"]),
    revision: z.number().int().nonnegative(),
    summary: z.string().min(1).max(2_048),
    issues: z.array(verificationIssueSchema).min(1).max(20),
    fingerprint: z.string().min(1).max(120),
  })
  .strict();

export type VerificationFailure = z.infer<typeof verificationFailureSchema>;

export type PreviewVerificationState = {
  attempted: boolean;
  ok: boolean;
  revision: number | null;
  failure: VerificationFailure | null;
};

export function deriveVerificationFailure(
  result: RunPreviewResult,
): VerificationFailure | null {
  if (result.ok) {
    return null;
  }

  if (result.build.install.status === "failed") {
    return createFailure({
      code: "install_failed",
      stage: "install",
      revision: result.revision,
      summary: result.summary,
      issues: messagesToIssues(
        "install",
        "INSTALL_FAILED",
        result.build.errors.length
          ? result.build.errors
          : ["依赖安装未成功完成。"],
      ),
    });
  }

  if (result.build.devServer.status === "failed") {
    return createFailure({
      code: "dev_server_failed",
      stage: "dev_server",
      revision: result.revision,
      summary: result.summary,
      issues: messagesToIssues(
        "dev_server",
        "DEV_SERVER_FAILED",
        result.build.errors.length
          ? result.build.errors
          : ["开发服务器未能进入 ready 状态。"],
      ),
    });
  }

  if (result.build.errors.length > 0) {
    return createFailure({
      code: "build_failed",
      stage: "build",
      revision: result.revision,
      summary: result.summary,
      issues: messagesToIssues("build", "BUILD_ERROR", result.build.errors),
    });
  }

  const runtimeIssues = runtimeEvidenceToIssues(result.runtime);
  if (runtimeIssues.length > 0) {
    const hasUnhandledRejection = runtimeIssues.some(
      (issue) => issue.code === "UNHANDLED_REJECTION",
    );
    return createFailure({
      code: hasUnhandledRejection ? "unhandled_rejection" : "runtime_error",
      stage: "runtime",
      revision: result.revision,
      summary: result.summary,
      issues: runtimeIssues,
    });
  }

  const consoleErrors = result.console.entries.filter(
    (entry) => entry.level === "error",
  );
  if (consoleErrors.length > 0) {
    return createFailure({
      code: "console_error",
      stage: "console",
      revision: result.revision,
      summary: result.summary,
      issues: consoleErrors.map((entry) => ({
        source: "console" as const,
        code: "CONSOLE_ERROR",
        message: entry.arguments.join(" ").slice(0, 2_048),
      })),
    });
  }

  return createFailure({
    code: result.runtime.rendered ? "preview_failed" : "render_failed",
    stage: "runtime",
    revision: result.revision,
    summary: result.summary,
    issues: [
      {
        source: "runtime",
        code: result.runtime.rendered ? "PREVIEW_FAILED" : "RENDER_FAILED",
        message: result.summary,
      },
    ],
  });
}

/**
 * 成功门禁只查看当前 Run 的 run_preview Tool Result，并要求最后一次结果
 * 与 Run 当前 revision 完全一致。旧 revision 曾经成功不能证明后续修改可运行。
 */
export function getPreviewVerificationState(
  run: Pick<AgentRunRecord, "id" | "currentRevision">,
  transcript: readonly TranscriptMessage[],
): PreviewVerificationState {
  const latestPreview = transcript
    .filter(
      (
        message,
      ): message is Extract<TranscriptMessage, { kind: "tool_result" }> =>
        message.kind === "tool_result" &&
        message.runId === run.id &&
        message.toolName === "run_preview",
    )
    .at(-1);

  if (!latestPreview) {
    return { attempted: false, ok: false, revision: null, failure: null };
  }

  const result = latestPreview.resultJson;
  const revision = typeof result.revision === "number" ? result.revision : null;
  const failureResult = verificationFailureSchema.safeParse(
    result.verificationFailure,
  );

  return {
    attempted: true,
    ok: result.ok === true && revision === run.currentRevision,
    revision,
    failure: failureResult.success ? failureResult.data : null,
  };
}

export function buildVerificationDirective(
  run: Pick<AgentRunRecord, "id" | "currentRevision">,
  transcript: readonly TranscriptMessage[],
): string {
  const state = getPreviewVerificationState(run, transcript);

  if (!state.attempted) {
    return [
      "Runtime verification state:",
      `- Revision ${run.currentRevision} has not been checked by run_preview.`,
      "- Do not finish. Call run_preview for the latest revision after the requested mutation is ready.",
    ].join("\n");
  }

  if (state.ok) {
    return [
      "Runtime verification state:",
      `- Revision ${run.currentRevision} has a successful run_preview result.`,
      "- You may finish only if the user's requested change is also complete.",
    ].join("\n");
  }

  if (state.revision !== run.currentRevision) {
    return [
      "Runtime verification state:",
      `- The latest preview covered revision ${state.revision ?? "unknown"}, but the current revision is ${run.currentRevision}.`,
      "- Do not finish. Run the latest revision before claiming success.",
    ].join("\n");
  }

  return [
    "Runtime verification state:",
    `- Revision ${run.currentRevision} failed preview verification.`,
    state.failure
      ? `- Structured failure: ${JSON.stringify(state.failure)}`
      : "- Inspect the latest run_preview tool result for structured evidence.",
    "- Continue in this exact order: evidence -> search -> read -> one mutation -> run_preview.",
  ].join("\n");
}

function createFailure(
  input: Omit<VerificationFailure, "kind" | "fingerprint">,
): VerificationFailure {
  const normalizedIssues = input.issues.slice(0, 20).map((issue) => ({
    ...issue,
    message: issue.message.slice(0, 2_048),
    ...(issue.stack ? { stack: issue.stack.slice(0, 8_192) } : {}),
  }));
  const fingerprintSource = normalizedIssues
    .map((issue) =>
      [
        issue.source,
        issue.code,
        normalizeFingerprintText(issue.message),
        normalizeFingerprintText(issue.stack ?? ""),
      ].join(":"),
    )
    .join("|");

  return verificationFailureSchema.parse({
    ...input,
    kind: "verification_failure",
    issues: normalizedIssues,
    fingerprint: `${input.code}:${hashFingerprint(fingerprintSource)}`,
  });
}

function messagesToIssues(
  source: "install" | "dev_server" | "build",
  code: string,
  messages: readonly string[],
): VerificationFailure["issues"] {
  return messages.slice(0, 20).map((message) => ({
    source,
    code,
    message,
  }));
}

function runtimeEvidenceToIssues(
  evidence: RuntimeEvidence,
): VerificationFailure["issues"] {
  return evidence.events
    .filter(
      (
        event,
      ): event is typeof event & {
        type: "RUNTIME_ERROR" | "UNHANDLED_REJECTION";
      } =>
        event.type === "RUNTIME_ERROR" || event.type === "UNHANDLED_REJECTION",
    )
    .slice(0, 20)
    .map((event) => ({
      source: "runtime" as const,
      code: event.type,
      message: event.message ?? event.type,
      ...(event.stack ? { stack: event.stack } : {}),
    }));
}

function normalizeFingerprintText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bhttps?:\/\/\S+/g, "<url>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function hashFingerprint(value: string): string {
  // FNV-1a 足以做“同类证据”比较；这里不承担安全摘要职责，且可在浏览器端复用。
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
