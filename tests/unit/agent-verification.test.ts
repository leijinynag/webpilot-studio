import { describe, expect, it } from "vitest";

import {
  browserVerifyToolArgumentsSchema,
  type BrowserVerifyResult,
} from "@/domains/agent/client-tools";
import type { RunPreviewResult } from "@/domains/agent/evidence";
import type { AgentRunRecord, TranscriptMessage } from "@/domains/agent/types";
import {
  buildVerificationDirective,
  deriveVerificationFailure,
  evaluateBrowserVerification,
  getPreviewVerificationState,
} from "@/domains/agent/verification";

function createRun(
  currentRevision: number,
  options: { fileMutations?: number } = {},
): AgentRunRecord {
  const now = new Date();
  return {
    id: "run-1",
    conversationId: "conversation-1",
    projectId: "project-1",
    ownerId: "owner-1",
    status: "running",
    startRevision: 1,
    currentRevision,
    locale: "zh-CN",
    provider: "deepseek",
    model: "deepseek-chat",
    promptProfile: "webpilot-system-v3",
    promptDigest: "digest",
    toolsetProfile: "webpilot-preview-v2",
    toolsetDigest: "digest",
    modelProfile: "coding-agent-v1",
    repositoryCapability: {
      storageKind: "database",
      canRead: true,
      canWrite: true,
      canExecuteServerTools: true,
    },
    budget: {
      maxModelTurns: 12,
      maxWallTimeSeconds: 300,
      maxOutputCharacters: 24_000,
      maxToolResultCharacters: 20_000,
      maxFileMutations: 8,
      maxClientResumes: 6,
      maxNoProgressRepeats: 2,
    },
    usage: {
      modelTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      fileMutations: options.fileMutations ?? 0,
      clientResumes: 0,
      consecutiveEmptyToolCallTurns: 0,
      repairRounds: 0,
      repeatedFailureCount: 0,
      activeExecutionDurationMs: 0,
      activeExecutionStartedAt: null,
      firstPreviewAt: null,
      firstPreviewDurationMs: null,
      latestPreviewAt: null,
      latestVerificationRevision: null,
      latestVerificationOk: null,
      latestFailureFingerprint: null,
    },
    correlationId: "correlation",
    executionLeaseId: null,
    executionLeaseExpiresAt: null,
    cancellationRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

function createRuntimeFailure(revision: number): RunPreviewResult {
  return {
    ok: false,
    toolName: "run_preview",
    revision,
    durationMs: 2_345,
    summary: "页面产生 1 个运行时错误。",
    build: {
      revision,
      install: { status: "succeeded", exitCode: 0 },
      devServer: {
        status: "ready",
        port: 5173,
        url: "https://preview.example",
      },
      errors: [],
      logs: [],
    },
    runtime: {
      revision,
      rendered: true,
      events: [
        { type: "RENDER_OK", timestamp: 1 },
        {
          type: "RUNTIME_ERROR",
          message: "Cannot read properties of undefined (reading 'label')",
          stack: "TypeError: Cannot read properties of undefined\n at onClick",
          timestamp: 2,
        },
      ],
      diagnostics: [],
    },
    console: {
      revision,
      entries: [],
      totalBytes: 0,
      truncated: false,
    },
  };
}

function createBrowserResult(
  revision: number,
  overrides: Partial<BrowserVerifyResult> = {},
): BrowserVerifyResult {
  return {
    ok: true,
    toolName: "browser_verify",
    verificationRunId: "00000000-0000-4000-8000-000000000001",
    revision,
    replayCount: 0,
    durationMs: 3_456,
    summary: "客户端声称验证通过。",
    build: {
      revision,
      install: { status: "succeeded", exitCode: 0 },
      devServer: {
        status: "ready",
        port: 5173,
        url: "https://preview.example",
      },
      errors: [],
      logs: [],
    },
    runtime: {
      revision,
      rendered: true,
      events: [{ type: "RENDER_OK", timestamp: 100 }],
      diagnostics: [],
    },
    console: {
      revision,
      entries: [],
      totalBytes: 0,
      truncated: false,
    },
    browser: {
      revision,
      sessionId: "session-1",
      ok: true,
      steps: [
        {
          index: 0,
          action: "click",
          startedAt: 100,
          durationMs: 10,
          target: { strategy: "test_id", value: "submit" },
          status: "passed",
          message: "已点击提交按钮。",
          error: null,
        },
        {
          index: 1,
          action: "assert_text",
          startedAt: 120,
          durationMs: 10,
          target: null,
          status: "passed",
          message: "页面包含成功文本。",
          error: null,
        },
      ],
      failedStep: null,
      domContext: null,
    },
    network: {
      revision,
      sessionId: "session-1",
      entries: [],
      totalBytes: 0,
      truncated: false,
      includesSuccessful: false,
    },
    acceptedNetworkFailures: [],
    checks: {
      build: true,
      runtime: true,
      console: true,
      network: true,
      actions: true,
      assertions: true,
      revision: true,
    },
    ...overrides,
  };
}

const smokeSteps = [
  {
    action: "click" as const,
    target: { strategy: "test_id" as const, value: "submit" },
  },
  {
    action: "assert_text" as const,
    text: "保存成功",
  },
];

describe("Agent preview verification", () => {
  it("把 Runtime TypeError 归一为稳定的 VerificationFailure", () => {
    const first = deriveVerificationFailure(createRuntimeFailure(3));
    const second = deriveVerificationFailure(createRuntimeFailure(4));

    expect(first).toMatchObject({
      kind: "verification_failure",
      code: "runtime_error",
      stage: "runtime",
      revision: 3,
      issues: [
        {
          source: "runtime",
          code: "RUNTIME_ERROR",
          message: expect.stringContaining("Cannot read properties"),
        },
      ],
    });
    // fingerprint 不包含 revision，可用于判断新旧 revision 是否仍是同类错误。
    expect(second?.fingerprint).toBe(first?.fingerprint);
  });

  it("只允许当前 revision 的最后一次成功 Preview 通过完成门禁", () => {
    const failure = deriveVerificationFailure(createRuntimeFailure(2));
    const transcript: TranscriptMessage[] = [
      {
        conversationId: "conversation-1",
        runId: "run-1",
        role: "tool",
        kind: "tool_result",
        toolCallId: "preview-1",
        toolName: "run_preview",
        resultJson: {
          ...createRuntimeFailure(2),
          verificationFailure: failure,
        },
      },
      {
        conversationId: "conversation-1",
        runId: "run-1",
        role: "tool",
        kind: "tool_result",
        toolCallId: "preview-2",
        toolName: "run_preview",
        resultJson: {
          ...createRuntimeFailure(3),
          ok: true,
          verificationFailure: null,
        },
      },
    ];

    expect(getPreviewVerificationState(createRun(3), transcript)).toMatchObject(
      {
        attempted: true,
        ok: true,
        revision: 3,
      },
    );
    expect(getPreviewVerificationState(createRun(4), transcript).ok).toBe(
      false,
    );
    expect(buildVerificationDirective(createRun(4), transcript)).toContain(
      "latest preview covered revision 3",
    );
  });

  it("只读 Run 没有验证请求时允许模型直接结束", () => {
    const run = createRun(1, { fileMutations: 0 });

    expect(buildVerificationDirective(run, [])).toContain(
      "may answer and finish now",
    );
  });

  it("发生文件 mutation 后仍要求当前 revision 的 Preview", () => {
    const run = createRun(1, { fileMutations: 1 });

    expect(buildVerificationDirective(run, [])).toContain(
      "Do not finish. Call run_preview",
    );
  });
});

describe("Browser verification", () => {
  it("使用 strict schema 拒绝未知字段和缺少断言的 smoke plan", () => {
    expect(
      browserVerifyToolArgumentsSchema.safeParse({
        revision: 1,
        steps: [
          {
            action: "click",
            target: { strategy: "test_id", value: "submit" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      browserVerifyToolArgumentsSchema.safeParse({
        revision: 1,
        steps: [
          {
            action: "assert_text",
            text: "保存成功",
            unexpected: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("只豁免 method、origin、path 和 status 全部匹配的网络失败", () => {
    const networkFailure = {
      requestType: "fetch" as const,
      method: "POST",
      status: 500,
      durationMs: 20,
      timestamp: 130,
      url: {
        origin: "https://api.example.com",
        path: "/health",
        queryKeys: [],
      },
      failed: true,
      error: null,
    };
    const result = createBrowserResult(3, {
      network: {
        revision: 3,
        sessionId: "session-1",
        entries: [networkFailure],
        totalBytes: 128,
        truncated: false,
        includesSuccessful: false,
      },
    });

    const accepted = evaluateBrowserVerification({
      result,
      submittedRevision: 3,
      currentRevision: 3,
      smokeSteps,
      acceptedNetworkFailures: [
        {
          method: "POST",
          origin: "https://api.example.com",
          path: "/health",
          statuses: [500],
        },
      ],
    });
    const wrongStatus = evaluateBrowserVerification({
      result,
      submittedRevision: 3,
      currentRevision: 3,
      smokeSteps,
      acceptedNetworkFailures: [
        {
          method: "POST",
          origin: "https://api.example.com",
          path: "/health",
          statuses: [404],
        },
      ],
    });

    expect(accepted.result.checks.network).toBe(true);
    expect(accepted.result.ok).toBe(true);
    expect(wrongStatus.result.checks.network).toBe(false);
    expect(wrongStatus.failure).toMatchObject({
      code: "network_failed",
      stage: "network",
    });
  });

  it("忽略客户端伪造的 ok/checks，并依据失败断言重新判定", () => {
    const forged = createBrowserResult(4, {
      browser: {
        revision: 4,
        sessionId: "session-1",
        ok: false,
        steps: [
          {
            index: 0,
            action: "click",
            startedAt: 100,
            durationMs: 10,
            target: { strategy: "test_id", value: "submit" },
            status: "passed",
            message: "已点击提交按钮。",
            error: null,
          },
          {
            index: 1,
            action: "assert_text",
            startedAt: 120,
            durationMs: 500,
            target: null,
            status: "failed",
            message: "页面未出现保存成功。",
            error: {
              code: "assertion_failed",
              message: "页面未出现保存成功。",
            },
          },
        ],
        failedStep: 1,
        domContext: null,
      },
    });

    const evaluation = evaluateBrowserVerification({
      result: forged,
      submittedRevision: 4,
      currentRevision: 4,
      smokeSteps,
      acceptedNetworkFailures: [],
    });

    expect(evaluation.result.ok).toBe(false);
    expect(evaluation.result.checks.assertions).toBe(false);
    expect(evaluation.failure).toMatchObject({
      code: "browser_assertion_failed",
      stage: "assertion",
    });
  });

  it("任一 Evidence revision 过期时拒绝通过当前 revision 门禁", () => {
    const stale = createBrowserResult(5, {
      runtime: {
        revision: 4,
        rendered: true,
        events: [{ type: "RENDER_OK", timestamp: 100 }],
        diagnostics: [],
      },
    });
    const evaluation = evaluateBrowserVerification({
      result: stale,
      submittedRevision: 5,
      currentRevision: 5,
      smokeSteps,
      acceptedNetworkFailures: [],
    });

    expect(evaluation.result.checks.revision).toBe(false);
    expect(evaluation.result.ok).toBe(false);
    expect(evaluation.failure).toMatchObject({
      code: "stale_revision",
      stage: "revision",
    });
  });
});
