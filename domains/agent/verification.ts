import { z } from "zod";

import type { NetworkEntry } from "@/domains/agent/browser-evidence";
import {
  BROWSER_VERIFY_TOOL_NAME,
  type AcceptedNetworkFailure,
  type BrowserVerificationChecks,
  type BrowserVerifyResult,
} from "@/domains/agent/client-tools";
import type {
  RunPreviewResult,
  RuntimeEvidence,
} from "@/domains/agent/evidence";
import type { AgentRunRecord, TranscriptMessage } from "@/domains/agent/types";
import type { VerificationRunRecord } from "@/domains/agent/types";

const verificationIssueSchema = z
  .object({
    source: z.enum([
      "install",
      "dev_server",
      "build",
      "runtime",
      "console",
      "network",
      "browser",
      "assertion",
      "revision",
    ]),
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
      "network_failed",
      "browser_action_failed",
      "browser_assertion_failed",
      "stale_revision",
    ]),
    stage: z.enum([
      "install",
      "dev_server",
      "build",
      "runtime",
      "console",
      "network",
      "browser",
      "assertion",
      "revision",
    ]),
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

export type AgentVerificationState = PreviewVerificationState & {
  kind: "preview" | "browser";
  replayCount: number;
  summary: string | null;
};

const ASSERTION_ACTIONS = new Set([
  "assert_text",
  "assert_visible",
  "assert_url",
]);

export type BrowserVerificationEvaluation = {
  result: BrowserVerifyResult;
  failure: VerificationFailure | null;
};

/**
 * browser_verify 的可信结果只由服务端依据原始 Evidence 计算。
 * submittedRevision 是 API 请求携带的 fence，currentRevision 是数据库事实；
 * 两者以及每一种 Evidence 都必须指向同一个 revision。
 */
export function evaluateBrowserVerification(input: {
  result: BrowserVerifyResult;
  submittedRevision: number;
  currentRevision: number;
  smokeSteps: readonly { action: string }[];
  acceptedNetworkFailures: readonly AcceptedNetworkFailure[];
}): BrowserVerificationEvaluation {
  const result = input.result;
  const build =
    result.build.install.status === "succeeded" &&
    result.build.devServer.status === "ready" &&
    result.build.errors.length === 0;
  const runtime =
    result.runtime.rendered &&
    !result.runtime.events.some(
      (event) =>
        event.type === "RUNTIME_ERROR" || event.type === "UNHANDLED_REJECTION",
    );
  const consoleOk = !result.console.entries.some(
    (entry) => entry.level === "error",
  );
  const unacceptedNetworkFailures = result.network.entries.filter(
    (entry) =>
      entry.failed &&
      !input.acceptedNetworkFailures.some((accepted) =>
        matchesAcceptedNetworkFailure(entry, accepted),
      ),
  );
  const evidenceRevisions = [
    result.revision,
    result.build.revision,
    result.runtime.revision,
    result.console.revision,
    result.browser.revision,
    result.network.revision,
  ];
  const revision =
    input.submittedRevision === input.currentRevision &&
    evidenceRevisions.every((value) => value === input.currentRevision);
  const resultByIndex = new Map(
    result.browser.steps.map((step) => [step.index, step]),
  );
  const actionIndexes = input.smokeSteps
    .map((step, index) => ({ action: step.action, index }))
    .filter((step) => !ASSERTION_ACTIONS.has(step.action));
  const assertionIndexes = input.smokeSteps
    .map((step, index) => ({ action: step.action, index }))
    .filter((step) => ASSERTION_ACTIONS.has(step.action));
  const actions =
    actionIndexes.length === 0 ||
    actionIndexes.every(
      ({ index }) => resultByIndex.get(index)?.status === "passed",
    );
  const assertions =
    assertionIndexes.length > 0 &&
    assertionIndexes.every(
      ({ index }) => resultByIndex.get(index)?.status === "passed",
    );
  const checks: BrowserVerificationChecks = {
    build,
    runtime,
    console: consoleOk,
    network: unacceptedNetworkFailures.length === 0,
    actions,
    assertions,
    revision,
  };
  const ok = Object.values(checks).every(Boolean);
  const normalizedResult: BrowserVerifyResult = {
    ...result,
    ok,
    toolName: BROWSER_VERIFY_TOOL_NAME,
    acceptedNetworkFailures: [...input.acceptedNetworkFailures],
    checks,
    summary: createBrowserVerificationSummary({
      ok,
      checks,
      failedStep: result.browser.failedStep,
      unacceptedNetworkFailures: unacceptedNetworkFailures.length,
    }),
  };

  return {
    result: normalizedResult,
    failure: ok
      ? null
      : deriveBrowserVerificationFailure(
          normalizedResult,
          unacceptedNetworkFailures,
        ),
  };
}

function matchesAcceptedNetworkFailure(
  entry: NetworkEntry,
  accepted: AcceptedNetworkFailure,
): boolean {
  if (
    accepted.method &&
    entry.method.toUpperCase() !== accepted.method.toUpperCase()
  ) {
    return false;
  }
  if (accepted.origin && entry.url.origin !== accepted.origin) {
    return false;
  }
  if (entry.url.path !== accepted.path) {
    return false;
  }
  return (
    !accepted.statuses ||
    (entry.status !== null && accepted.statuses.includes(entry.status))
  );
}

function createBrowserVerificationSummary(input: {
  ok: boolean;
  checks: BrowserVerificationChecks;
  failedStep: number | null;
  unacceptedNetworkFailures: number;
}): string {
  if (input.ok) {
    return "浏览器冒烟验证通过，构建、运行时、网络、动作和断言均与当前 revision 匹配。";
  }

  const failedChecks = Object.entries(input.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return [
    `浏览器冒烟验证失败：${failedChecks.join(", ")}。`,
    input.failedStep === null ? "" : `失败步骤：${input.failedStep}。`,
    input.unacceptedNetworkFailures > 0
      ? `未获准的失败请求：${input.unacceptedNetworkFailures} 条。`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function deriveBrowserVerificationFailure(
  result: BrowserVerifyResult,
  networkFailures: readonly NetworkEntry[],
): VerificationFailure {
  if (!result.checks.revision) {
    return createFailure({
      code: "stale_revision",
      stage: "revision",
      revision: result.revision,
      summary: result.summary,
      issues: [
        {
          source: "revision",
          code: "STALE_REVISION",
          message: "验证结果或其中的 Evidence 未绑定当前 Run revision。",
        },
      ],
    });
  }

  const previewFailure = deriveVerificationFailure({
    ok: result.checks.build && result.checks.runtime && result.checks.console,
    toolName: "run_preview",
    revision: result.revision,
    durationMs: result.durationMs,
    summary: result.summary,
    build: result.build,
    runtime: result.runtime,
    console: result.console,
  });
  if (previewFailure) {
    return previewFailure;
  }

  if (!result.checks.network) {
    return createFailure({
      code: "network_failed",
      stage: "network",
      revision: result.revision,
      summary: result.summary,
      issues: networkFailures.slice(0, 20).map((entry) => ({
        source: "network" as const,
        code: `HTTP_${entry.status ?? "ERROR"}`,
        message: `${entry.method} ${entry.url.origin}${entry.url.path} ${entry.error ?? entry.status ?? "failed"}`,
      })),
    });
  }

  const failedStep = result.browser.steps.find(
    (step) => step.status === "failed",
  );
  const assertionFailed =
    failedStep && ASSERTION_ACTIONS.has(failedStep.action);
  return createFailure({
    code: assertionFailed
      ? "browser_assertion_failed"
      : "browser_action_failed",
    stage: assertionFailed ? "assertion" : "browser",
    revision: result.revision,
    summary: result.summary,
    issues: [
      {
        source: assertionFailed ? "assertion" : "browser",
        code: failedStep?.error?.code ?? "BROWSER_STEP_FAILED",
        message: failedStep?.error?.message ?? result.summary,
      },
    ],
  });
}

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
  run: Pick<AgentRunRecord, "id" | "currentRevision" | "usage">,
  transcript: readonly TranscriptMessage[],
): string {
  const state = getPreviewVerificationState(run, transcript);

  if (!state.attempted) {
    if (run.usage.fileMutations === 0) {
      return [
        "Runtime verification state:",
        "- This Run has not changed any files and has not requested runtime verification.",
        "- If the user asked for information or repository inspection, you may answer and finish now.",
        "- Do not call run_preview only to answer a read-only request.",
      ].join("\n");
    }

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

/**
 * M4 profile 只相信数据库中的 Browser Verification facts。历史 M3 profile
 * 仍沿用 Transcript 中的 run_preview，保证冻结 digest 对应的行为不会漂移。
 */
export function getAgentVerificationState(input: {
  run: Pick<
    AgentRunRecord,
    "id" | "currentRevision" | "toolsetProfile" | "usage"
  >;
  transcript: readonly TranscriptMessage[];
  latestVerificationRun: VerificationRunRecord | null;
}): AgentVerificationState {
  if (!isBrowserVerificationToolset(input.run.toolsetProfile)) {
    const preview = getPreviewVerificationState(input.run, input.transcript);
    return {
      ...preview,
      kind: "preview",
      replayCount: 0,
      summary: null,
    };
  }

  const verification = input.latestVerificationRun;
  if (!verification) {
    const preview = getPreviewVerificationState(input.run, input.transcript);

    return {
      // Browser profile 下 run_preview 只是中间证据，不能代替交互验证。
      // 但它仍属于一次验证尝试，必须阻止模型在 Preview 后直接文本收尾。
      attempted: preview.attempted,
      ok: false,
      revision: preview.revision,
      failure: preview.failure,
      kind: "browser",
      replayCount: 0,
      summary: null,
    };
  }

  return {
    attempted: true,
    ok:
      verification.status === "passed" &&
      verification.revision === input.run.currentRevision &&
      verification.revisionOk === true &&
      verification.buildOk === true &&
      verification.runtimeOk === true &&
      verification.consoleOk === true &&
      verification.networkOk === true &&
      verification.actionsOk === true &&
      verification.assertionsOk === true,
    revision: verification.revision,
    failure: null,
    kind: "browser",
    replayCount: verification.replayCount,
    summary: verification.summary,
  };
}

function isBrowserVerificationToolset(toolsetProfile: string): boolean {
  // 历史 Run 可能仍然冻结在旧 profile，因此这里不能只判断当前版本。
  // M6 新增 Vision 和 Image 能力后，Browser Verify 仍然属于同一套
  // 浏览器验证门禁，必须继续复用 replay 和 completion gate。
  return [
    "webpilot-browser-v3",
    "webpilot-browser-v4",
    "webpilot-browser-v5",
    "webpilot-browser-git-v4",
    "webpilot-browser-git-v5",
    "webpilot-browser-git-v6",
  ].includes(toolsetProfile);
}

export function buildAgentVerificationDirective(input: {
  run: Pick<
    AgentRunRecord,
    "id" | "currentRevision" | "toolsetProfile" | "usage"
  >;
  transcript: readonly TranscriptMessage[];
  latestVerificationRun: VerificationRunRecord | null;
}): string {
  if (!isBrowserVerificationToolset(input.run.toolsetProfile)) {
    return buildVerificationDirective(input.run, input.transcript);
  }

  const state = getAgentVerificationState(input);
  const verification = input.latestVerificationRun;

  if (!state.attempted) {
    if (input.run.usage.fileMutations === 0) {
      return [
        "Browser verification state:",
        "- This Run has not changed any files and has not requested browser verification.",
        "- For an informational or repository-inspection request, answer the user and finish normally.",
        "- Do not call run_preview or browser_verify only to answer a read-only request.",
      ].join("\n");
    }

    return [
      "Browser verification state:",
      `- Revision ${input.run.currentRevision} has no browser_verify result.`,
      "- Do not finish. Submit executable smoke steps with at least one assertion.",
    ].join("\n");
  }

  if (state.ok) {
    return [
      "Browser verification state:",
      `- Revision ${input.run.currentRevision} passed the complete browser verification gate.`,
      `- Replay count: ${state.replayCount}.`,
      `- Summary: ${state.summary ?? "All checks passed."}`,
      "- You may finish only if the requested code change is also complete.",
    ].join("\n");
  }

  if (state.revision !== input.run.currentRevision) {
    return [
      "Browser verification state:",
      `- Latest evidence covers revision ${state.revision ?? "unknown"}, current revision is ${input.run.currentRevision}.`,
      "- Do not finish. The canonical smoke plan must be replayed on the current revision.",
    ].join("\n");
  }

  return [
    "Browser verification state:",
    `- Revision ${input.run.currentRevision} failed browser verification.`,
    `- Replay count: ${state.replayCount}.`,
    `- Summary: ${state.summary ?? "Browser verification failed."}`,
    verification
      ? `- Checks: ${JSON.stringify({
          build: verification.buildOk,
          runtime: verification.runtimeOk,
          console: verification.consoleOk,
          network: verification.networkOk,
          actions: verification.actionsOk,
          assertions: verification.assertionsOk,
          revision: verification.revisionOk,
          failedStep: verification.failedStep,
        })}`
      : "",
    "- Inspect persisted browser/network evidence, apply one focused mutation, then allow automatic replay.",
  ]
    .filter(Boolean)
    .join("\n");
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
