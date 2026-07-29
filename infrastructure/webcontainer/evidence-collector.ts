import {
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_TOTAL_BYTES,
  type BuildEvidence,
  type ConsoleEvidence,
  type RunPreviewResult,
  RUN_PREVIEW_TOOL_NAME,
  type RuntimeBridgeDiagnostic,
  type RuntimeEnvelope,
  type RuntimeEvidence,
} from "@/domains/agent/evidence";
import type { WebContainerRuntimeSnapshot } from "@/infrastructure/webcontainer/lifecycle";

const textEncoder = new TextEncoder();
const BUILD_ERROR_PATTERN =
  /(?:\berror\b|\bfailed\b|\bexception\b|npm err|编译失败|构建失败)/i;
const FORWARDED_BROWSER_ERROR_PATTERN = /\[dev\]\s+error\s+\[browser\]/i;

/**
 * Collector 只在一次 run_preview 的观察窗口内存活。Console 与 Runtime
 * 事件持续累积到窗口结束，不会因为首个 render 或首条 error 提前完成。
 */
export class PreviewEvidenceCollector {
  private readonly runtimeEvents: RuntimeEvidence["events"] = [];
  private readonly diagnostics: RuntimeBridgeDiagnostic[] = [];
  private readonly consoleEntries: ConsoleEvidence["entries"] = [];
  private readonly startedAt = Date.now();
  private consoleBytes = 0;
  private consoleTruncated = false;

  constructor(private readonly revision: number) {}

  hasRendered(): boolean {
    return this.runtimeEvents.some((event) => event.type === "RENDER_OK");
  }

  addEnvelope(envelope: RuntimeEnvelope): void {
    if (envelope.type === "CONSOLE_WARN" || envelope.type === "CONSOLE_ERROR") {
      this.addConsoleEnvelope(envelope);
      return;
    }

    if (this.runtimeEvents.length >= 50) {
      return;
    }

    switch (envelope.type) {
      case "RENDER_OK":
        this.runtimeEvents.push({
          type: envelope.type,
          timestamp: envelope.payload.timestamp,
        });
        return;
      case "RUNTIME_ERROR":
      case "UNHANDLED_REJECTION":
        this.runtimeEvents.push({
          type: envelope.type,
          message: envelope.payload.message,
          stack: envelope.payload.stack,
          timestamp: envelope.payload.timestamp,
        });
        return;
    }
  }

  addDiagnostic(diagnostic: RuntimeBridgeDiagnostic): void {
    if (this.diagnostics.length < 50) {
      this.diagnostics.push(diagnostic);
    }
  }

  finish(snapshot: WebContainerRuntimeSnapshot): RunPreviewResult {
    const build = createBuildEvidence(snapshot, this.revision);
    const runtimeEvents = mergeForwardedPreviewErrors(
      this.runtimeEvents,
      snapshot,
      this.revision,
      this.startedAt,
    );
    const runtime: RuntimeEvidence = {
      revision: this.revision,
      rendered: runtimeEvents.some((event) => event.type === "RENDER_OK"),
      events: runtimeEvents,
      diagnostics: this.diagnostics,
    };
    const consoleEvidence: ConsoleEvidence = {
      revision: this.revision,
      entries: this.consoleEntries,
      totalBytes: this.consoleBytes,
      truncated: this.consoleTruncated,
    };
    const hasRuntimeFailure = runtime.events.some(
      (event) =>
        event.type === "RUNTIME_ERROR" || event.type === "UNHANDLED_REJECTION",
    );
    const hasConsoleError = consoleEvidence.entries.some(
      (entry) => entry.level === "error",
    );
    const buildReady =
      build.install.status === "succeeded" &&
      build.devServer.status === "ready";
    const ok =
      buildReady && runtime.rendered && !hasRuntimeFailure && !hasConsoleError;

    return {
      ok,
      toolName: RUN_PREVIEW_TOOL_NAME,
      revision: this.revision,
      summary: createSummary({
        ok,
        rendered: runtime.rendered,
        runtimeFailures: runtime.events.filter(
          (event) => event.type !== "RENDER_OK",
        ).length,
        consoleWarnings: consoleEvidence.entries.filter(
          (entry) => entry.level === "warn",
        ).length,
        consoleErrors: consoleEvidence.entries.filter(
          (entry) => entry.level === "error",
        ).length,
        buildErrors: build.errors.length,
      }),
      build,
      runtime,
      console: consoleEvidence,
    };
  }

  private addConsoleEnvelope(
    envelope: Extract<
      RuntimeEnvelope,
      { type: "CONSOLE_WARN" | "CONSOLE_ERROR" }
    >,
  ): void {
    if (this.consoleEntries.length >= MAX_CONSOLE_ENTRIES) {
      this.consoleTruncated = true;
      return;
    }

    const entryBytes = envelope.payload.arguments.reduce(
      (total, argument) => total + textEncoder.encode(argument).byteLength,
      0,
    );

    if (this.consoleBytes + entryBytes > MAX_CONSOLE_TOTAL_BYTES) {
      this.consoleTruncated = true;
      return;
    }

    this.consoleBytes += entryBytes;
    this.consoleEntries.push({
      level: envelope.type === "CONSOLE_WARN" ? "warn" : "error",
      arguments: envelope.payload.arguments,
      timestamp: envelope.payload.timestamp,
    });
  }
}

function createBuildEvidence(
  snapshot: WebContainerRuntimeSnapshot,
  revision: number,
): BuildEvidence {
  const installFailed = snapshot.diagnostic?.code === "install_failed";
  const installSucceeded =
    snapshot.phase === "starting" ||
    snapshot.phase === "ready" ||
    snapshot.diagnostic?.code === "dev_server_failed";
  const devServerFailed = snapshot.diagnostic?.code === "dev_server_failed";
  const errors = [
    ...(snapshot.diagnostic
      ? [
          snapshot.diagnostic.detail
            ? `${snapshot.diagnostic.message} ${snapshot.diagnostic.detail}`
            : snapshot.diagnostic.message,
        ]
      : []),
    ...snapshot.logs.filter((line) => BUILD_ERROR_PATTERN.test(line)),
  ]
    .filter((line) => !FORWARDED_BROWSER_ERROR_PATTERN.test(line))
    .slice(-50);

  return {
    revision,
    install: {
      status: installFailed
        ? "failed"
        : installSucceeded
          ? "succeeded"
          : "not_started",
      exitCode: installFailed ? parseExitCode(snapshot) : null,
    },
    devServer: {
      status:
        snapshot.phase === "ready"
          ? "ready"
          : devServerFailed
            ? "failed"
            : "not_started",
      port: snapshot.port,
      url: snapshot.previewUrl,
    },
    errors,
    logs: snapshot.logs.slice(-80),
  };
}

function mergeForwardedPreviewErrors(
  runtimeEvents: RuntimeEvidence["events"],
  snapshot: WebContainerRuntimeSnapshot,
  revision: number,
  startedAt: number,
): RuntimeEvidence["events"] {
  const merged = [...runtimeEvents];

  for (const error of snapshot.forwardedPreviewErrors) {
    if (
      error.revision !== revision ||
      error.timestamp < startedAt ||
      merged.some(
        (event) =>
          event.type === "RUNTIME_ERROR" && event.message === error.message,
      )
    ) {
      continue;
    }

    merged.push({
      type: "RUNTIME_ERROR",
      message: error.message,
      timestamp: error.timestamp,
    });
  }

  return merged;
}

function parseExitCode(snapshot: WebContainerRuntimeSnapshot): number | null {
  const source = [
    snapshot.diagnostic?.message,
    snapshot.diagnostic?.detail,
    ...snapshot.logs.slice(-20),
  ]
    .filter(Boolean)
    .join("\n");
  const match = source.match(/退出码\s+(-?\d+)/);

  return match ? Number(match[1]) : null;
}

function createSummary(input: {
  ok: boolean;
  rendered: boolean;
  runtimeFailures: number;
  consoleWarnings: number;
  consoleErrors: number;
  buildErrors: number;
}): string {
  if (input.ok) {
    return `Preview 验证通过：页面已渲染，观察到 ${input.consoleWarnings} 条 warning，未发现 runtime 或 console error。`;
  }

  return [
    "Preview 验证失败。",
    input.rendered ? "页面已产生首帧。" : "未观察到页面首帧。",
    `构建错误 ${input.buildErrors} 条，runtime 异常 ${input.runtimeFailures} 条，console error ${input.consoleErrors} 条。`,
  ].join(" ");
}
