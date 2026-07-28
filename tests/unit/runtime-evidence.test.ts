import { describe, expect, it } from "vitest";

import {
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_TOTAL_BYTES,
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_PROBE_TYPE,
  RUNTIME_BRIDGE_VERSION,
  runtimeEnvelopeSchema,
  runtimeProbeSchema,
} from "@/domains/agent/evidence";
import { PreviewEvidenceCollector } from "@/infrastructure/webcontainer/evidence-collector";
import { createInitialRuntimeSnapshot } from "@/infrastructure/webcontainer/lifecycle";
import { injectRuntimeBridge } from "@/infrastructure/webcontainer/runtime-bridge";

const runId = "28f966a6-51d4-45ab-930c-87ec9206107b";

describe("Preview Runtime Bridge", () => {
  it("只修改运行镜像副本，并保留 Repository 模板原值", () => {
    const tree = {
      "index.html": {
        file: {
          contents:
            '<html><head></head><body><div id="root"></div></body></html>',
        },
      },
    };

    const instrumented = injectRuntimeBridge(tree, {
      runId,
      revision: 7,
    });
    const originalHtml = tree["index.html"].file.contents;
    const instrumentedEntry = instrumented["index.html"];
    const bridgeEntry =
      instrumented.public &&
      "directory" in instrumented.public &&
      instrumented.public.directory.__webpilot &&
      "directory" in instrumented.public.directory.__webpilot
        ? Object.values(instrumented.public.directory.__webpilot.directory)[0]
        : undefined;
    const bridgeContents =
      bridgeEntry && "file" in bridgeEntry && "contents" in bridgeEntry.file
        ? bridgeEntry.file.contents.toString()
        : "";
    const instrumentedHtml =
      instrumentedEntry &&
      "file" in instrumentedEntry &&
      "contents" in instrumentedEntry.file
        ? instrumentedEntry.file.contents.toString()
        : "";

    expect(originalHtml).not.toContain(RUNTIME_BRIDGE_CHANNEL);
    expect(tree).not.toHaveProperty("public");
    expect(instrumentedHtml).toContain(
      `/__webpilot/runtime-bridge-${runId}-7.js`,
    );
    expect(bridgeContents).toContain(RUNTIME_BRIDGE_CHANNEL);
    expect(bridgeContents).toContain(RUNTIME_BRIDGE_PROBE_TYPE);
    expect(instrumented).not.toBe(tree);
  });

  it("拒绝未知版本、未知 type 和额外字段", () => {
    const validEnvelope = {
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId,
      revision: 3,
      type: "RENDER_OK",
      payload: { timestamp: 100 },
    };

    expect(runtimeEnvelopeSchema.safeParse(validEnvelope).success).toBe(true);
    expect(
      runtimeEnvelopeSchema.safeParse({ ...validEnvelope, version: 2 }).success,
    ).toBe(false);
    expect(
      runtimeEnvelopeSchema.safeParse({ ...validEnvelope, type: "UNKNOWN" })
        .success,
    ).toBe(false);
    expect(
      runtimeEnvelopeSchema.safeParse({ ...validEnvelope, unexpected: true })
        .success,
    ).toBe(false);
  });

  it("宿主探测严格绑定 Bridge 版本、Run 与 revision", () => {
    const probe = {
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId,
      revision: 3,
      type: RUNTIME_BRIDGE_PROBE_TYPE,
    };

    expect(runtimeProbeSchema.safeParse(probe).success).toBe(true);
    expect(
      runtimeProbeSchema.safeParse({ ...probe, runId: "unknown" }).success,
    ).toBe(false);
    expect(
      runtimeProbeSchema.safeParse({ ...probe, extra: true }).success,
    ).toBe(false);
  });
});

describe("PreviewEvidenceCollector", () => {
  it("持续累积 Runtime 与 Console，并执行条数和总字节上限", () => {
    const collector = new PreviewEvidenceCollector(3);
    collector.addEnvelope({
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId,
      revision: 3,
      type: "RENDER_OK",
      payload: { timestamp: 100 },
    });

    for (let index = 0; index < 80; index += 1) {
      collector.addEnvelope({
        channel: RUNTIME_BRIDGE_CHANNEL,
        version: RUNTIME_BRIDGE_VERSION,
        runId,
        revision: 3,
        type: index % 2 === 0 ? "CONSOLE_WARN" : "CONSOLE_ERROR",
        payload: {
          arguments: [`${index}:${"x".repeat(900)}`],
          timestamp: 101 + index,
        },
      });
    }

    const snapshot = {
      ...createInitialRuntimeSnapshot(),
      phase: "ready" as const,
      previewUrl: "https://5173-webpilot.local",
      port: 5173,
      syncedRevision: 3,
      logs: ["[install] dependencies installed", "[dev] ready"],
    };
    const result = collector.finish(snapshot);

    expect(result.runtime.rendered).toBe(true);
    expect(result.console.entries.length).toBeLessThanOrEqual(
      MAX_CONSOLE_ENTRIES,
    );
    expect(result.console.totalBytes).toBeLessThanOrEqual(
      MAX_CONSOLE_TOTAL_BYTES,
    );
    expect(result.console.truncated).toBe(true);
    expect(result.ok).toBe(false);
  });
});
