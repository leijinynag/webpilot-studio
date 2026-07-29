import { describe, expect, it } from "vitest";

import type { RunPreviewResult } from "@/domains/agent/evidence";
import type { AgentRunRecord, TranscriptMessage } from "@/domains/agent/types";
import {
  buildVerificationDirective,
  deriveVerificationFailure,
  getPreviewVerificationState,
} from "@/domains/agent/verification";

function createRun(currentRevision: number): AgentRunRecord {
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
      fileMutations: 0,
      clientResumes: 0,
      repairRounds: 0,
      repeatedFailureCount: 0,
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
});
