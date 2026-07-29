import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_BRIDGE_RESPONSE_TYPE,
  type BrowserBridgeRequest,
} from "@/domains/agent/browser-evidence";
import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_VERSION,
} from "@/domains/agent/evidence";
import { BrowserBridgeController } from "@/infrastructure/webcontainer/browser-bridge-controller";

const runId = "28f966a6-51d4-45ab-930c-87ec9206107b";
const revision = 12;
const sessionId = "verification-controller";
const previewUrl = "https://preview.example/app";

describe("BrowserBridgeController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("只接受 source、origin、run、revision、session 与 requestId 全部匹配的响应", async () => {
    const controller = new BrowserBridgeController();
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    const iframe = { contentWindow: source } as HTMLIFrameElement;
    const resultPromise = controller.request({
      command: { name: "start_session" },
      iframe,
      previewUrl,
      revision,
      runId,
      sessionId,
    });
    const request = postMessage.mock.calls[0]?.[0] as BrowserBridgeRequest;

    expect(
      controller.handleMessage(
        createMessageEvent({
          request,
          source: window,
        }),
      ),
    ).toBe(true);

    controller.handleMessage(createMessageEvent({ request, source }));
    await expect(resultPromise).resolves.toEqual({
      commandName: "start_session",
      ok: true,
      result: { started: true },
    });
    controller.dispose();
  });

  it("超时后拒绝 Promise，并忽略迟到响应", async () => {
    vi.useFakeTimers();
    const controller = new BrowserBridgeController();
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as Window;
    const iframe = { contentWindow: source } as HTMLIFrameElement;
    const resultPromise = controller.request({
      command: { name: "start_session" },
      iframe,
      previewUrl,
      revision,
      runId,
      sessionId,
      timeoutMs: 100,
    });
    const request = postMessage.mock.calls[0]?.[0] as BrowserBridgeRequest;
    const rejection = expect(resultPromise).rejects.toThrow("等待响应超时");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(
      controller.handleMessage(createMessageEvent({ request, source })),
    ).toBe(true);
    controller.dispose();
  });
});

function createMessageEvent(input: {
  request: BrowserBridgeRequest;
  source: Window;
}): MessageEvent<unknown> {
  return {
    data: {
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId,
      revision,
      type: BROWSER_BRIDGE_RESPONSE_TYPE,
      requestId: input.request.requestId,
      sessionId,
      payload: {
        commandName: "start_session",
        ok: true,
        result: { started: true },
      },
    },
    origin: new URL(previewUrl).origin,
    source: input.source,
  } as MessageEvent<unknown>;
}
