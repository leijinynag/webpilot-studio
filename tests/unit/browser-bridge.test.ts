import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_BRIDGE_REQUEST_TYPE,
  BROWSER_BRIDGE_RESPONSE_TYPE,
  browserBridgeResponseSchema,
  type BrowserBridgeRequest,
  type BrowserBridgeResponse,
} from "@/domains/agent/browser-evidence";
import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_VERSION,
} from "@/domains/agent/evidence";
import { createRuntimeBridgeScript } from "@/infrastructure/webcontainer/runtime-bridge";

const runId = "28f966a6-51d4-45ab-930c-87ec9206107b";
const revision = 12;

type BrowserBridgeHarness = ReturnType<typeof createBrowserBridgeHarness>;
type RuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<{ status: number }>;
type RuntimeXMLHttpRequest = {
  status: number;
  open(method: string, url: string, ...rest: unknown[]): void;
  setRequestHeader(name: string, value: string): void;
  send(body?: Document | XMLHttpRequestBodyInit | null): void;
  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
};
type RuntimeXMLHttpRequestConstructor = new () => RuntimeXMLHttpRequest;

describe("Browser Runtime Bridge", () => {
  let harness: BrowserBridgeHarness;

  beforeEach(() => {
    document.body.innerHTML = "";
    harness = createBrowserBridgeHarness();
  });

  afterEach(() => {
    harness.restore();
    vi.restoreAllMocks();
  });

  it("按 testid、role+name、稳定 CSS、scan id 的顺序生成有界 DOM Evidence", async () => {
    document.body.innerHTML = `
      <button data-testid="save-button">保存</button>
      <label for="email">邮箱</label>
      <input id="email" />
      <button id="first-duplicate">重复</button>
      <button class="generated-a1b2c3d4">重复</button>
    `;

    await harness.startSession("verification-a");
    const response = await harness.send({
      name: "scan_dom",
    });

    expect(response.payload.ok).toBe(true);
    if (!response.payload.ok || response.payload.commandName !== "scan_dom") {
      throw new Error("预期收到 scan_dom 成功响应。");
    }

    const evidence = response.payload.result;
    const saveButton = evidence.nodes.find(
      (node) => node.testId === "save-button",
    );
    const emailInput = evidence.nodes.find((node) => node.tag === "input");
    const duplicateButtons = evidence.nodes.filter(
      (node) => node.name === "重复",
    );

    expect(saveButton?.target).toEqual({
      strategy: "test_id",
      value: "save-button",
    });
    expect(emailInput?.target).toEqual({
      strategy: "role_name",
      role: "textbox",
      name: "邮箱",
    });
    expect(duplicateButtons[0]?.target).toEqual({
      strategy: "css",
      selector: "#first-duplicate",
    });
    expect(duplicateButtons[1]?.target.strategy).toBe("scan_id");
    expect(evidence.summary).toContain('[button name="保存"');
    expect(evidence.summary).not.toContain("<button");
    expect(evidence.totalBytes).toBeLessThanOrEqual(16 * 1024);
    expect(evidence.nodes.length).toBeLessThanOrEqual(60);
  });

  it("显式 role+name 目标存在歧义时结构化失败，不随机选择首个元素", async () => {
    document.body.innerHTML = `
      <button>删除</button>
      <button>删除</button>
    `;
    const clickSpy = vi.spyOn(HTMLButtonElement.prototype, "click");

    await harness.startSession("verification-b");
    const response = await harness.send({
      name: "execute_steps",
      steps: [
        {
          action: "click",
          target: {
            strategy: "role_name",
            role: "button",
            name: "删除",
          },
          timeoutMs: 100,
        },
      ],
    });

    expect(response.payload.ok).toBe(true);
    if (
      !response.payload.ok ||
      response.payload.commandName !== "execute_steps"
    ) {
      throw new Error("预期收到 execute_steps 成功响应。");
    }

    expect(response.payload.result.ok).toBe(false);
    expect(response.payload.result.failedStep).toBe(0);
    expect(response.payload.result.steps[0]?.error?.code).toBe(
      "target_ambiguous",
    );
    expect(response.payload.result.domContext?.revision).toBe(revision);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("scan id 对应元素消失后返回 target_not_found，并在 session 结束时清理标记", async () => {
    document.body.innerHTML = `
      <button class="generated-a1b2c3d4">临时按钮</button>
      <button class="generated-a1b2c3d4">临时按钮</button>
    `;

    await harness.startSession("verification-c");
    const scanResponse = await harness.send({ name: "scan_dom" });
    if (
      !scanResponse.payload.ok ||
      scanResponse.payload.commandName !== "scan_dom"
    ) {
      throw new Error("预期收到 scan_dom 成功响应。");
    }

    const scannedNode = scanResponse.payload.result.nodes.find(
      (node) => node.target.strategy === "scan_id",
    );
    expect(scannedNode).toBeDefined();
    const scannedElement = document.querySelector(
      `[data-webpilot-scan-id="${scannedNode?.scanId}"]`,
    );
    scannedElement?.remove();

    const executeResponse = await harness.send({
      name: "execute_steps",
      steps: [
        {
          action: "click",
          target: scannedNode?.target ?? {
            strategy: "scan_id",
            id: "missing",
          },
          timeoutMs: 100,
        },
      ],
    });
    if (
      !executeResponse.payload.ok ||
      executeResponse.payload.commandName !== "execute_steps"
    ) {
      throw new Error("预期收到 execute_steps 成功响应。");
    }

    expect(executeResponse.payload.result.steps[0]?.error?.code).toBe(
      "timeout",
    );
    expect(executeResponse.payload.result.steps[0]?.message).toContain(
      "没有找到目标元素",
    );

    await harness.send({ name: "end_session" });
    expect(
      document.querySelector("[data-webpilot-scan-id]"),
    ).not.toBeInTheDocument();
  });

  it("执行 click、fill、select、press，并记录每一步的计时与目标", async () => {
    document.body.innerHTML = `
      <button data-testid="submit">提交</button>
      <input data-testid="email" />
      <select data-testid="role">
        <option value="viewer">访客</option>
        <option value="editor">编辑者</option>
      </select>
    `;
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="submit"]',
    );
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="email"]',
    );
    const select = document.querySelector<HTMLSelectElement>(
      '[data-testid="role"]',
    );
    const clicked = vi.fn();
    const inputEvents: string[] = [];
    const pressedKeys: string[] = [];
    button?.addEventListener("click", clicked);
    input?.addEventListener("input", (event) => inputEvents.push(event.type));
    input?.addEventListener("change", (event) => inputEvents.push(event.type));
    input?.addEventListener("keydown", (event) => pressedKeys.push(event.key));

    await harness.startSession("verification-actions");
    const response = await harness.send({
      name: "execute_steps",
      steps: [
        {
          action: "fill",
          target: { strategy: "test_id", value: "email" },
          value: "dev@example.com",
        },
        {
          action: "select",
          target: { strategy: "test_id", value: "role" },
          value: "editor",
        },
        {
          action: "press",
          target: { strategy: "test_id", value: "email" },
          key: "Enter",
        },
        {
          action: "click",
          target: { strategy: "test_id", value: "submit" },
        },
      ],
    });

    expect(response.payload.ok).toBe(true);
    if (
      !response.payload.ok ||
      response.payload.commandName !== "execute_steps"
    ) {
      throw new Error("预期收到 execute_steps 成功响应。");
    }

    expect(response.payload.result.ok).toBe(true);
    expect(response.payload.result.failedStep).toBeNull();
    expect(response.payload.result.domContext).toBeNull();
    expect(response.payload.result.steps).toHaveLength(4);
    expect(
      response.payload.result.steps.every(
        (step) =>
          step.status === "passed" &&
          step.startedAt > 0 &&
          step.durationMs >= 0 &&
          step.target !== null,
      ),
    ).toBe(true);
    expect(input?.value).toBe("dev@example.com");
    expect(inputEvents).toEqual(["input", "change"]);
    expect(select?.value).toBe("editor");
    expect(pressedKeys).toEqual(["Enter"]);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("React 风格实例 value 覆写不会阻断原生 setter 与 input/change 事件", async () => {
    document.body.innerHTML = `<input data-testid="controlled" />`;
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="controlled"]',
    );
    if (!input) {
      throw new Error("测试输入框未创建。");
    }

    const instanceSetter = vi.fn();
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "instance-value",
      set: instanceSetter,
    });
    const events: string[] = [];
    input.addEventListener("input", (event) => events.push(event.type));
    input.addEventListener("change", (event) => events.push(event.type));

    await harness.startSession("verification-controlled");
    const response = await harness.send({
      name: "execute_steps",
      steps: [
        {
          action: "fill",
          target: { strategy: "test_id", value: "controlled" },
          value: "native-value",
        },
      ],
    });
    if (
      !response.payload.ok ||
      response.payload.commandName !== "execute_steps"
    ) {
      throw new Error("预期收到 execute_steps 成功响应。");
    }

    expect(response.payload.result.ok).toBe(true);
    expect(instanceSetter).not.toHaveBeenCalled();
    expect(
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.get?.call(input),
    ).toBe("native-value");
    expect(events).toEqual(["input", "change"]);
  });

  it("等待异步 DOM 状态，并执行 text、visible、URL 断言", async () => {
    document.body.innerHTML = `
      <section data-testid="status" hidden>处理中</section>
    `;
    const status = document.querySelector<HTMLElement>(
      '[data-testid="status"]',
    );
    window.setTimeout(() => {
      if (status) {
        status.hidden = false;
        status.textContent = "保存成功";
      }
    }, 30);

    await harness.startSession("verification-assertions");
    const response = await harness.send({
      name: "execute_steps",
      steps: [
        {
          action: "wait_for",
          target: { strategy: "test_id", value: "status" },
          timeoutMs: 500,
        },
        {
          action: "assert_visible",
          target: { strategy: "test_id", value: "status" },
          timeoutMs: 500,
        },
        {
          action: "assert_text",
          target: { strategy: "test_id", value: "status" },
          text: "保存成功",
          timeoutMs: 500,
        },
        {
          action: "assert_text",
          text: "保存成功",
          timeoutMs: 500,
        },
        {
          action: "assert_url",
          pattern: "/form",
          timeoutMs: 500,
        },
      ],
    });
    if (
      !response.payload.ok ||
      response.payload.commandName !== "execute_steps"
    ) {
      throw new Error("预期收到 execute_steps 成功响应。");
    }

    expect(response.payload.result.ok).toBe(true);
    expect(response.payload.result.steps).toHaveLength(5);
    expect(
      response.payload.result.steps.every((step) => step.status === "passed"),
    ).toBe(true);
  });

  it("action/assertion timeout 有界，失败结果包含 step、DOM context 与 revision", async () => {
    document.body.innerHTML = `<main><h1>控制台</h1></main>`;

    await harness.startSession("verification-failure");
    const startedAt = Date.now();
    const response = await harness.send({
      name: "execute_steps",
      steps: [
        {
          action: "assert_visible",
          target: { strategy: "test_id", value: "never-appears" },
          timeoutMs: 100,
        },
        {
          action: "assert_text",
          text: "不应继续执行",
          timeoutMs: 100,
        },
      ],
    });
    const elapsed = Date.now() - startedAt;
    if (
      !response.payload.ok ||
      response.payload.commandName !== "execute_steps"
    ) {
      throw new Error("预期收到 execute_steps 成功响应。");
    }

    expect(elapsed).toBeLessThan(1_000);
    expect(response.payload.result.ok).toBe(false);
    expect(response.payload.result.failedStep).toBe(0);
    expect(response.payload.result.steps).toHaveLength(1);
    expect(response.payload.result.steps[0]).toEqual(
      expect.objectContaining({
        index: 0,
        action: "assert_visible",
        status: "failed",
        target: { strategy: "test_id", value: "never-appears" },
        error: expect.objectContaining({ code: "timeout" }),
      }),
    );
    expect(response.payload.result.domContext).toEqual(
      expect.objectContaining({
        revision,
        sessionId: "verification-failure",
      }),
    );
  });

  it("包装 fetch 与 XHR，并默认只返回失败请求", async () => {
    harness.restore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 204 })
      .mockResolvedValueOnce({ status: 503 });
    const networkHarness = createBrowserBridgeHarness({
      fetch: fetchMock,
      XMLHttpRequestClass: FakeXMLHttpRequest,
    });
    harness = networkHarness;

    await harness.startSession("verification-network");
    await harness.fetch?.(
      "https://api.example.com/users?page=1&token=secret-token",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer private-access-token",
          Cookie: "session=private-cookie",
        },
        body: "private-request-body",
      },
    );
    await harness.fetch?.(
      "https://api.example.com/failing?email=private@example.com&filter=active",
      {
        headers: {
          Authorization: "Bearer another-secret",
        },
      },
    );

    const xhr = harness.createXhr?.();
    xhr?.open(
      "PUT",
      "https://api.example.com/xhr?session=private-session&sort=desc",
    );
    xhr?.setRequestHeader("Authorization", "Bearer xhr-secret");
    xhr?.setRequestHeader("Cookie", "xhr-cookie");
    if (xhr) {
      xhr.status = 500;
    }
    xhr?.send("xhr-private-body");

    const failedOnly = await harness.send({ name: "get_network" });
    if (
      !failedOnly.payload.ok ||
      failedOnly.payload.commandName !== "get_network"
    ) {
      throw new Error("预期收到 get_network 成功响应。");
    }

    expect(failedOnly.payload.result.includesSuccessful).toBe(false);
    expect(failedOnly.payload.result.entries).toHaveLength(2);
    expect(
      failedOnly.payload.result.entries.every((entry) => entry.failed),
    ).toBe(true);
    expect(failedOnly.payload.result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestType: "fetch",
          method: "GET",
          status: 503,
          url: {
            origin: "https://api.example.com",
            path: "/failing",
            queryKeys: ["email", "filter"],
          },
        }),
        expect.objectContaining({
          requestType: "xhr",
          method: "PUT",
          status: 500,
          url: {
            origin: "https://api.example.com",
            path: "/xhr",
            queryKeys: ["session", "sort"],
          },
        }),
      ]),
    );

    const withSuccess = await harness.send({
      name: "get_network",
      includeSuccessful: true,
    });
    if (
      !withSuccess.payload.ok ||
      withSuccess.payload.commandName !== "get_network"
    ) {
      throw new Error("预期收到 get_network 成功响应。");
    }

    expect(withSuccess.payload.result.includesSuccessful).toBe(true);
    expect(withSuccess.payload.result.entries).toHaveLength(3);
    expect(
      withSuccess.payload.result.entries.find((entry) => entry.status === 204),
    ).toEqual(
      expect.objectContaining({
        requestType: "fetch",
        method: "POST",
        failed: false,
        url: {
          origin: "https://api.example.com",
          path: "/users",
          queryKeys: ["page", "token"],
        },
      }),
    );

    const serializedEvidence = JSON.stringify(withSuccess.payload.result);
    for (const secret of [
      "secret-token",
      "private-access-token",
      "private-cookie",
      "private-request-body",
      "private@example.com",
      "private-session",
      "xhr-secret",
      "xhr-cookie",
      "xhr-private-body",
      "Authorization",
      "Cookie",
    ]) {
      expect(serializedEvidence).not.toContain(secret);
    }
  });

  it("网络缓冲限制为 30 条，并在总量或条数超限时标记 truncated", async () => {
    harness.restore();
    const fetchMock = vi.fn(async () => ({ status: 500 }));
    harness = createBrowserBridgeHarness({ fetch: fetchMock });

    await harness.startSession("verification-network-limit");
    for (let index = 0; index < 40; index += 1) {
      await harness.fetch?.(
        `https://api.example.com/failure/${index}?request=${index}`,
      );
    }

    const response = await harness.send({
      name: "get_network",
      includeSuccessful: true,
    });
    if (
      !response.payload.ok ||
      response.payload.commandName !== "get_network"
    ) {
      throw new Error("预期收到 get_network 成功响应。");
    }

    expect(response.payload.result.entries).toHaveLength(30);
    expect(response.payload.result.totalBytes).toBeLessThanOrEqual(16 * 1024);
    expect(response.payload.result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(40);
  });
});

function createBrowserBridgeHarness(options?: {
  fetch?: RuntimeFetch;
  XMLHttpRequestClass?: RuntimeXMLHttpRequestConstructor;
}) {
  const posted: unknown[] = [];
  const listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  const parent = {
    postMessage: vi.fn((message: unknown) => {
      posted.push(message);
    }),
  };
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  const fakeConsole = {
    warn: vi.fn(),
    error: vi.fn(),
  };
  const fakeWindow = {
    parent,
    location: new URL("https://preview.example/form"),
    fetch: options?.fetch,
    getComputedStyle: window.getComputedStyle.bind(window),
    setTimeout: window.setTimeout.bind(window),
    addEventListener: (
      type: string,
      listener: (event: MessageEvent) => void,
    ) => {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
  };

  const execute = new Function(
    "window",
    "document",
    "console",
    "Node",
    "Element",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "XMLHttpRequest",
    "Request",
    "Event",
    "KeyboardEvent",
    "CSS",
    "URL",
    "TextEncoder",
    "requestAnimationFrame",
    createRuntimeBridgeScript({ runId, revision }),
  );
  execute(
    fakeWindow,
    document,
    fakeConsole,
    Node,
    Element,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    options?.XMLHttpRequestClass,
    Request,
    Event,
    KeyboardEvent,
    globalThis.CSS,
    URL,
    TextEncoder,
    (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  );

  let requestSequence = 0;
  let sessionId = "";

  async function send(
    command: BrowserBridgeRequest["command"],
  ): Promise<BrowserBridgeResponse> {
    requestSequence += 1;
    const request: BrowserBridgeRequest = {
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId,
      revision,
      type: BROWSER_BRIDGE_REQUEST_TYPE,
      requestId: `request-${requestSequence}`,
      sessionId,
      command,
    };
    const messageListener = listeners.get("message")?.at(-1);
    if (!messageListener) {
      throw new Error("Bridge 未注册 message listener。");
    }

    messageListener({
      data: request,
      source: parent,
      origin: "https://studio.example",
    } as unknown as MessageEvent);

    await vi.waitFor(() => {
      expect(
        posted.some(
          (message) =>
            isRecord(message) &&
            message.type === BROWSER_BRIDGE_RESPONSE_TYPE &&
            message.requestId === request.requestId,
        ),
      ).toBe(true);
    });

    const rawResponse = posted.find(
      (message) =>
        isRecord(message) &&
        message.type === BROWSER_BRIDGE_RESPONSE_TYPE &&
        message.requestId === request.requestId,
    );
    return browserBridgeResponseSchema.parse(rawResponse);
  }

  async function startSession(nextSessionId: string) {
    sessionId = nextSessionId;
    return send({ name: "start_session" });
  }

  return {
    createXhr: options?.XMLHttpRequestClass
      ? () => new options.XMLHttpRequestClass!()
      : undefined,
    fetch:
      typeof fakeWindow.fetch === "function"
        ? fakeWindow.fetch.bind(fakeWindow)
        : undefined,
    restore() {
      console.warn = originalConsoleWarn;
      console.error = originalConsoleError;
    },
    send,
    startSession,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class FakeXMLHttpRequest {
  status = 0;

  private readonly listeners = new Map<
    string,
    Array<{ listener: EventListener; once: boolean }>
  >();

  open(): void {}

  setRequestHeader(): void {}

  send(): void {
    this.dispatch("loadend");
  }

  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const current = this.listeners.get(type) ?? [];
    current.push({
      listener,
      once: typeof options === "object" && options.once === true,
    });
    this.listeners.set(type, current);
  }

  private dispatch(type: string): void {
    const current = this.listeners.get(type) ?? [];
    const event = new Event(type);
    for (const entry of current) {
      entry.listener.call(this as unknown as EventTarget, event);
    }
    this.listeners.set(
      type,
      current.filter((entry) => !entry.once),
    );
  }
}
