import { describe, expect, it, vi } from "vitest";

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
import {
  createRuntimeBridgeScript,
  injectRuntimeBridge,
} from "@/infrastructure/webcontainer/runtime-bridge";

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

  it("安全序列化 Error、循环引用、DOM Node、超深对象并按 UTF-8 字节截断", () => {
    const posted: Array<{
      type: string;
      payload: { arguments: string[] };
    }> = [];
    const parent = {
      postMessage: vi.fn((message: (typeof posted)[number]) => {
        posted.push(message);
      }),
    };
    const fakeWindow = {
      parent,
      addEventListener: vi.fn(),
    };
    const fakeConsole = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    class FakeNode {
      static readonly ELEMENT_NODE = 1;
      readonly nodeType = FakeNode.ELEMENT_NODE;
      readonly nodeName = "BUTTON";
      readonly id = "save";
      readonly className = "primary";
      readonly textContent = "保存";
      readonly parentElement = null;
    }

    const execute = new Function(
      "window",
      "document",
      "console",
      "Node",
      "TextEncoder",
      "requestAnimationFrame",
      createRuntimeBridgeScript({ runId, revision: 9 }),
    );
    execute(
      fakeWindow,
      { referrer: "https://studio.example/p/project" },
      fakeConsole,
      FakeNode,
      TextEncoder,
      (callback: () => void) => callback(),
    );

    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;
    const deep = { a: { b: { c: { d: { e: { f: "too-deep" } } } } } };
    const longUnicode = "错".repeat(2_000);
    fakeConsole.error(
      new TypeError("button handler failed"),
      circular,
      new FakeNode(),
      deep,
      longUnicode,
    );

    const consoleMessage = posted.find(
      (message) => message.type === "CONSOLE_ERROR",
    );
    expect(consoleMessage).toBeDefined();
    const serialized = consoleMessage?.payload.arguments ?? [];
    expect(serialized[0]).toContain("TypeError");
    expect(serialized[0]).toContain("button handler failed");
    expect(serialized[1]).toContain("[Circular]");
    expect(serialized[2]).toContain('"node":"BUTTON"');
    expect(serialized[3]).toContain("[MaxDepth]");
    expect(serialized[4]).toContain("...[truncated]");
    expect(
      new TextEncoder().encode(serialized[4]).byteLength,
    ).toBeLessThanOrEqual(2 * 1024);
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

  it("把 WebContainer 转发的浏览器异常归入 Runtime，而不是 Build", () => {
    const collector = new PreviewEvidenceCollector(7);
    const snapshot = {
      ...createInitialRuntimeSnapshot(),
      phase: "ready" as const,
      previewUrl: "https://5173-webpilot.local",
      port: 5173,
      syncedRevision: 7,
      logs: [
        "[dev] ready built in 0.42s",
        "[dev] error [browser] Uncaught TypeError: Cannot read properties of null",
      ],
      forwardedPreviewErrors: [
        {
          revision: 7,
          message: "Uncaught TypeError: Cannot read properties of null",
          timestamp: Date.now(),
        },
      ],
    };

    const result = collector.finish(snapshot);

    expect(result.build.errors).toEqual([]);
    expect(result.runtime.events).toContainEqual(
      expect.objectContaining({
        type: "RUNTIME_ERROR",
        message: expect.stringContaining("TypeError"),
      }),
    );
    expect(result.ok).toBe(false);
  });
});
