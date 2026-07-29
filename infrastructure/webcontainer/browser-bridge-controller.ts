import {
  BROWSER_BRIDGE_REQUEST_TYPE,
  BROWSER_BRIDGE_RESPONSE_TYPE,
  type BrowserBridgeRequest,
  type BrowserBridgeResponse,
  type BrowserCommand,
  browserBridgeRequestSchema,
  browserBridgeResponseSchema,
} from "@/domains/agent/browser-evidence";
import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_VERSION,
} from "@/domains/agent/evidence";

type BrowserBridgePayload = BrowserBridgeResponse["payload"];

type PendingBrowserRequest = {
  commandName: BrowserCommand["name"];
  expectedOrigin: string;
  revision: number;
  runId: string;
  sessionId: string;
  source: Window;
  resolve: (payload: BrowserBridgePayload) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

type BrowserBridgeRequestInput = {
  command: BrowserCommand;
  iframe: HTMLIFrameElement;
  previewUrl: string;
  revision: number;
  runId: string;
  sessionId: string;
  timeoutMs?: number;
};

const DEFAULT_BROWSER_BRIDGE_TIMEOUT_MS = 6_000;

/**
 * 管理宿主页面与 Preview iframe 之间的一次一答协议。
 *
 * Runtime Evidence 是持续事件流，Browser Command 则必须严格匹配 requestId。
 * 将 pending Promise 集中管理后，组件刷新、超时和卸载都能统一清理，不会让
 * 上一个 iframe 的迟到响应完成当前 revision 的验证。
 */
export class BrowserBridgeController {
  private readonly pending = new Map<string, PendingBrowserRequest>();
  private requestSequence = 0;

  request(input: BrowserBridgeRequestInput): Promise<BrowserBridgePayload> {
    const source = input.iframe.contentWindow;
    if (!source) {
      return Promise.reject(new Error("Preview iframe 尚未建立浏览上下文。"));
    }

    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(input.previewUrl).origin;
    } catch {
      return Promise.reject(
        new Error("Preview URL 无效，无法发送浏览器命令。"),
      );
    }

    this.requestSequence += 1;
    const requestId =
      `${input.sessionId}:${Date.now()}:${this.requestSequence}`.slice(0, 200);
    const request: BrowserBridgeRequest = browserBridgeRequestSchema.parse({
      channel: RUNTIME_BRIDGE_CHANNEL,
      version: RUNTIME_BRIDGE_VERSION,
      runId: input.runId,
      revision: input.revision,
      type: BROWSER_BRIDGE_REQUEST_TYPE,
      requestId,
      sessionId: input.sessionId,
      command: input.command,
    });

    return new Promise<BrowserBridgePayload>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }

        this.pending.delete(requestId);
        pending.reject(
          new Error(`Browser Bridge 命令 ${input.command.name} 等待响应超时。`),
        );
      }, input.timeoutMs ?? DEFAULT_BROWSER_BRIDGE_TIMEOUT_MS);

      this.pending.set(requestId, {
        commandName: input.command.name,
        expectedOrigin,
        revision: input.revision,
        runId: input.runId,
        sessionId: input.sessionId,
        source,
        resolve,
        reject,
        timeoutId,
      });

      try {
        source.postMessage(request, expectedOrigin);
      } catch (error) {
        this.rejectPending(
          requestId,
          error instanceof Error
            ? error
            : new Error("Browser Bridge 命令发送失败。"),
        );
      }
    });
  }

  /**
   * 返回 true 表示消息属于 Browser Bridge 协议，即使它因安全边界不匹配而
   * 被忽略，也不应再交给 Runtime Evidence parser 产生无意义诊断。
   */
  handleMessage(event: MessageEvent<unknown>): boolean {
    const raw =
      event.data !== null && typeof event.data === "object"
        ? (event.data as Record<string, unknown>)
        : null;
    if (
      raw?.channel !== RUNTIME_BRIDGE_CHANNEL ||
      raw.type !== BROWSER_BRIDGE_RESPONSE_TYPE
    ) {
      return false;
    }

    if (typeof raw.requestId !== "string") {
      return true;
    }

    const requestId = raw.requestId;
    const pending = this.pending.get(requestId);
    if (!pending) {
      return true;
    }

    // 不匹配的 source/origin 直接忽略，让可信 iframe 仍有机会在 timeout 前响应。
    if (
      event.source !== pending.source ||
      event.origin !== pending.expectedOrigin
    ) {
      return true;
    }

    const parsed = browserBridgeResponseSchema.safeParse(event.data);
    if (!parsed.success) {
      this.rejectPending(
        requestId,
        new Error("Browser Bridge 返回了不符合严格协议的响应。"),
      );
      return true;
    }

    const response = parsed.data;
    if (
      response.runId !== pending.runId ||
      response.revision !== pending.revision ||
      response.sessionId !== pending.sessionId ||
      response.payload.commandName !== pending.commandName
    ) {
      this.rejectPending(
        requestId,
        new Error("Browser Bridge 响应与当前验证上下文不匹配。"),
      );
      return true;
    }

    window.clearTimeout(pending.timeoutId);
    this.pending.delete(requestId);
    pending.resolve(response.payload);
    return true;
  }

  dispose(): void {
    for (const requestId of this.pending.keys()) {
      this.rejectPending(requestId, new Error("Browser Bridge 控制器已释放。"));
    }
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    window.clearTimeout(pending.timeoutId);
    this.pending.delete(requestId);
    pending.reject(error);
  }
}
