import type { FileSystemTree } from "@webcontainer/api";

import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_PROBE_TYPE,
  RUNTIME_BRIDGE_VERSION,
} from "@/domains/agent/evidence";
import {
  BROWSER_BRIDGE_REQUEST_TYPE,
  BROWSER_BRIDGE_RESPONSE_TYPE,
  MAX_BROWSER_STEPS,
  MAX_DOM_EVIDENCE_BYTES,
  MAX_DOM_EVIDENCE_NODES,
  MAX_NETWORK_ENTRIES,
  MAX_NETWORK_TOTAL_BYTES,
} from "@/domains/agent/browser-evidence";

type RuntimeBridgeContext = {
  runId: string;
  revision: number;
};

/**
 * 返回一个新的 WebContainer 文件树，并只修改其中的 index.html 副本。
 * 传入的 Repository 模板不会被原地改写，因此 Bridge 永远不会进入保存、
 * Git 或发布链路。
 */
export function injectRuntimeBridge(
  tree: FileSystemTree,
  context: RuntimeBridgeContext,
): FileSystemTree {
  const clonedTree = cloneFileSystemTree(tree);
  const indexEntry = clonedTree["index.html"];

  if (
    !indexEntry ||
    !("file" in indexEntry) ||
    !("contents" in indexEntry.file)
  ) {
    throw new Error(
      "运行镜像缺少 index.html，无法注入 Preview Runtime Bridge。",
    );
  }

  const originalHtml = indexEntry.file.contents.toString();
  const script = createRuntimeBridgeScript(context);
  // WebContainer 预览代理可能通过 CSP 禁止 inline script。Bridge 作为同源静态
  // 文件加载，既能稳定执行，也仍然只存在于克隆后的运行树。
  const bridgeFileName = `runtime-bridge-${context.runId}-${context.revision}.js`;
  const bridgePublicPath = `/__webpilot/${bridgeFileName}`;
  const publicEntry = clonedTree.public;

  if (publicEntry && !("directory" in publicEntry)) {
    throw new Error(
      "运行镜像中的 public 必须是目录，无法注入 Runtime Bridge。",
    );
  }

  const publicDirectory = publicEntry?.directory ?? {};
  const bridgeDirectoryEntry = publicDirectory.__webpilot;
  if (bridgeDirectoryEntry && !("directory" in bridgeDirectoryEntry)) {
    throw new Error(
      "运行镜像中的 public/__webpilot 必须是目录，无法注入 Runtime Bridge。",
    );
  }

  publicDirectory.__webpilot = {
    directory: {
      ...(bridgeDirectoryEntry?.directory ?? {}),
      [bridgeFileName]: {
        file: {
          contents: script,
        },
      },
    },
  };
  clonedTree.public = { directory: publicDirectory };
  indexEntry.file.contents = injectScriptIntoHtml(
    originalHtml,
    `<script defer src="${bridgePublicPath}"></script>`,
  );

  return clonedTree;
}

function cloneFileSystemTree(tree: FileSystemTree): FileSystemTree {
  const clone: FileSystemTree = {};

  for (const [name, entry] of Object.entries(tree)) {
    if ("file" in entry) {
      if ("symlink" in entry.file) {
        clone[name] = {
          file: {
            symlink: entry.file.symlink,
          },
        };
        continue;
      }

      clone[name] = {
        file: {
          contents:
            typeof entry.file.contents === "string"
              ? entry.file.contents
              : new Uint8Array(entry.file.contents),
        },
      };
      continue;
    }

    clone[name] = {
      directory: cloneFileSystemTree(entry.directory),
    };
  }

  return clone;
}

function injectScriptIntoHtml(html: string, scriptTag: string): string {
  const headCloseIndex = html.toLowerCase().lastIndexOf("</head>");

  if (headCloseIndex >= 0) {
    return `${html.slice(0, headCloseIndex)}${scriptTag}${html.slice(headCloseIndex)}`;
  }

  const bodyCloseIndex = html.toLowerCase().lastIndexOf("</body>");
  if (bodyCloseIndex >= 0) {
    return `${html.slice(0, bodyCloseIndex)}${scriptTag}${html.slice(bodyCloseIndex)}`;
  }

  return `${scriptTag}${html}`;
}

export function createRuntimeBridgeScript(
  context: RuntimeBridgeContext,
): string {
  const serializedContext = JSON.stringify({
    channel: RUNTIME_BRIDGE_CHANNEL,
    version: RUNTIME_BRIDGE_VERSION,
    runId: context.runId,
    revision: context.revision,
  });
  const serializedProbeType = JSON.stringify(RUNTIME_BRIDGE_PROBE_TYPE);
  const serializedBrowserRequestType = JSON.stringify(
    BROWSER_BRIDGE_REQUEST_TYPE,
  );
  const serializedBrowserResponseType = JSON.stringify(
    BROWSER_BRIDGE_RESPONSE_TYPE,
  );

  return `(() => {
  "use strict";

  const context = ${serializedContext};
  const MAX_ENTRY_BYTES = 2048;
  const MAX_DEPTH = 5;
  const MAX_DOM_NODES = ${MAX_DOM_EVIDENCE_NODES};
  const MAX_DOM_BYTES = ${MAX_DOM_EVIDENCE_BYTES};
  const MAX_BROWSER_STEPS = ${MAX_BROWSER_STEPS};
  const MAX_NETWORK_ENTRIES = ${MAX_NETWORK_ENTRIES};
  const MAX_NETWORK_BYTES = ${MAX_NETWORK_TOTAL_BYTES};
  const SCAN_ID_ATTRIBUTE = "data-webpilot-scan-id";
  const DEFAULT_STEP_TIMEOUT_MS = 2000;
  const encoder = new TextEncoder();
  let activeSessionId = null;
  let scanSequence = 0;
  let networkBytes = 0;
  let networkTruncated = false;
  let networkEntries = [];
  const scannedElements = new Set();

  function truncate(value) {
    if (encoder.encode(value).byteLength <= MAX_ENTRY_BYTES) {
      return value;
    }

    let left = 0;
    let right = value.length;
    while (left < right) {
      const middle = Math.ceil((left + right) / 2);
      if (encoder.encode(value.slice(0, middle)).byteLength <= MAX_ENTRY_BYTES - 16) {
        left = middle;
      } else {
        right = middle - 1;
      }
    }

    return value.slice(0, left) + "...[truncated]";
  }

  function normalize(value, depth, seen) {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (typeof Node !== "undefined" && value instanceof Node) {
      const element = value.nodeType === Node.ELEMENT_NODE ? value : value.parentElement;
      return {
        node: value.nodeName,
        id: element && "id" in element ? element.id || undefined : undefined,
        className:
          element && "className" in element && typeof element.className === "string"
            ? element.className || undefined
            : undefined,
        text: value.textContent ? value.textContent.slice(0, 200) : undefined,
      };
    }

    if (value === null || typeof value !== "object") {
      return typeof value === "bigint" ? value.toString() + "n" : value;
    }

    if (depth >= MAX_DEPTH) {
      return "[MaxDepth]";
    }

    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => normalize(item, depth + 1, seen));
    }

    const result = {};
    for (const key of Object.keys(value).slice(0, 50)) {
      try {
        result[key] = normalize(value[key], depth + 1, seen);
      } catch {
        result[key] = "[Unserializable]";
      }
    }
    return result;
  }

  function serialize(value) {
    try {
      const normalized = normalize(value, 0, new WeakSet());
      const serialized =
        typeof normalized === "string" ? normalized : JSON.stringify(normalized);
      return truncate(serialized === undefined ? String(value) : serialized);
    } catch {
      return truncate(String(value));
    }
  }

  function getReferrerOrigin() {
    try {
      return document.referrer ? new URL(document.referrer).origin : null;
    } catch {
      return null;
    }
  }

  function post(type, payload, explicitTargetOrigin) {
    const targetOrigin = explicitTargetOrigin || getReferrerOrigin();
    if (!targetOrigin) {
      return;
    }

    try {
      window.parent.postMessage({ ...context, type, payload }, targetOrigin);
    } catch {
      // origin 不可用时宁可丢弃证据，也不向通配目标发送运行时内容。
    }
  }

  function postBrowserResponse(request, payload, targetOrigin) {
    if (!targetOrigin) {
      return;
    }

    try {
      window.parent.postMessage(
        {
          ...context,
          type: ${serializedBrowserResponseType},
          requestId: request.requestId,
          sessionId: request.sessionId,
          payload,
        },
        targetOrigin,
      );
    } catch {
      // Browser Response 同样禁止回退到 "*"，origin 异常由宿主超时处理。
    }
  }

  function normalizeText(value, limit) {
    return String(value || "")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, limit);
  }

  function escapeCss(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }

    return String(value).replace(/([\\\\"'#.:\\[\\]()=+~*>|\\s])/g, "\\\\$1");
  }

  function escapeAttributeValue(value) {
    return String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
  }

  function isVisible(element) {
    if (!(element instanceof Element) || element.hidden) {
      return false;
    }

    if (element.getAttribute("aria-hidden") === "true") {
      return false;
    }

    const style =
      typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(element)
        : null;
    return !(
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0")
    );
  }

  function isDisabled(element) {
    return Boolean(
      "disabled" in element &&
        element.disabled,
    ) || element.getAttribute("aria-disabled") === "true";
  }

  function implicitRole(element) {
    const explicitRole = normalizeText(element.getAttribute("role"), 64);
    if (explicitRole) {
      return explicitRole.split(" ")[0];
    }

    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return element.multiple ? "listbox" : "combobox";
    if (tag === "summary") return "button";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag !== "input") return null;

    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type === "hidden") return null;
    return "textbox";
  }

  function getLabelText(element) {
    const labelledBy = normalizeText(element.getAttribute("aria-labelledby"), 500);
    if (labelledBy) {
      const text = labelledBy
        .split(/\\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((node) => normalizeText(node.textContent, 500))
        .filter(Boolean)
        .join(" ");
      if (text) return normalizeText(text, 500);
    }

    if ("labels" in element && element.labels && element.labels.length > 0) {
      const text = Array.from(element.labels)
        .map((label) => normalizeText(label.textContent, 500))
        .filter(Boolean)
        .join(" ");
      if (text) return normalizeText(text, 500);
    }

    return "";
  }

  function accessibleName(element) {
    const ariaLabel = normalizeText(element.getAttribute("aria-label"), 500);
    if (ariaLabel) return ariaLabel;

    const labelledText = getLabelText(element);
    if (labelledText) return labelledText;

    const tag = element.tagName.toLowerCase();
    if (tag === "img") {
      const alt = normalizeText(element.getAttribute("alt"), 500);
      if (alt) return alt;
    }

    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) {
        const value = normalizeText(element.value, 500);
        if (value) return value;
      }
    }

    const text = normalizeText(element.textContent, 500);
    if (text) return text;

    return normalizeText(
      element.getAttribute("placeholder") || element.getAttribute("title"),
      500,
    );
  }

  function isStableToken(value) {
    return (
      /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) &&
      !/(?:^|[-_])(css|sc|jsx)-/i.test(value) &&
      !/[a-f0-9]{8,}/i.test(value) &&
      !/\\d{5,}/.test(value)
    );
  }

  function hasSingleMatch(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function createStableSelector(element) {
    const tag = element.tagName.toLowerCase();
    const id = normalizeText(element.id, 128);
    if (id && isStableToken(id)) {
      const selector = "#" + escapeCss(id);
      if (hasSingleMatch(selector)) return selector;
    }

    for (const attribute of ["name", "aria-label", "href", "type"]) {
      const value = normalizeText(element.getAttribute(attribute), 500);
      if (!value || (attribute === "href" && /^https?:\\/\\//i.test(value))) {
        continue;
      }

      const selector =
        tag + "[" + attribute + '="' + escapeAttributeValue(value) + '"]';
      if (hasSingleMatch(selector)) return selector;
    }

    const stableClasses = Array.from(element.classList || [])
      .filter(isStableToken)
      .slice(0, 2);
    for (const className of stableClasses) {
      const selector = tag + "." + escapeCss(className);
      if (hasSingleMatch(selector)) return selector;
    }

    return null;
  }

  function ensureScanId(element) {
    const existing = normalizeText(element.getAttribute(SCAN_ID_ATTRIBUTE), 100);
    if (existing) {
      scannedElements.add(element);
      return existing;
    }

    scanSequence += 1;
    const scanId = "wp-" + scanSequence;
    element.setAttribute(SCAN_ID_ATTRIBUTE, scanId);
    scannedElements.add(element);
    return scanId;
  }

  function clearScanIds() {
    for (const element of scannedElements) {
      if (element && typeof element.removeAttribute === "function") {
        element.removeAttribute(SCAN_ID_ATTRIBUTE);
      }
    }
    scannedElements.clear();
    scanSequence = 0;
  }

  function beginSession(sessionId) {
    if (activeSessionId === sessionId) {
      return;
    }

    // scan id 只在一个 verification session 内有效。切换 session 时先清理，
    // 避免旧步骤误命中新页面或下一轮验证中的元素。
    clearScanIds();
    activeSessionId = sessionId;
    networkEntries = [];
    networkBytes = 0;
    networkTruncated = false;
  }

  function endSession() {
    clearScanIds();
    activeSessionId = null;
    networkEntries = [];
    networkBytes = 0;
    networkTruncated = false;
  }

  function chooseTarget(element, scanId) {
    const testId = normalizeText(element.getAttribute("data-testid"), 256);
    if (
      testId &&
      document.querySelectorAll(
        '[data-testid="' + escapeAttributeValue(testId) + '"]',
      ).length === 1
    ) {
      return { strategy: "test_id", value: testId };
    }

    const role = implicitRole(element);
    const name = accessibleName(element);
    if (role && name) {
      const roleMatches = Array.from(document.querySelectorAll("*")).filter(
        (candidate) =>
          implicitRole(candidate) === role && accessibleName(candidate) === name,
      );
      if (roleMatches.length === 1) {
        return { strategy: "role_name", role, name };
      }
    }

    const selector = createStableSelector(element);
    if (selector) {
      return { strategy: "css", selector };
    }

    return { strategy: "scan_id", id: scanId };
  }

  function formatDomNode(node) {
    const attributes = [];
    if (node.name) attributes.push('name="' + node.name.replace(/"/g, "'") + '"');
    if (node.testId) attributes.push('testid="' + node.testId.replace(/"/g, "'") + '"');
    if (node.inputType) attributes.push('type="' + node.inputType + '"');
    if (node.href) attributes.push('href="' + node.href.replace(/"/g, "'") + '"');
    if (!node.visible) attributes.push("hidden");
    if (node.disabled) attributes.push("disabled");

    const label = node.role || node.tag;
    const text = node.text && node.text !== node.name ? " " + JSON.stringify(node.text) : "";
    return "[" + label + (attributes.length ? " " + attributes.join(" ") : "") + "]" + text;
  }

  function scanDom() {
    const selector = [
      "button",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "a[href]",
      "summary",
      "[contenteditable='true']",
      "[role]",
      "[tabindex]:not([tabindex='-1'])",
      "h1",
      "h2",
      "h3",
      "label",
      "[data-testid]",
    ].join(",");
    const candidates = Array.from(document.querySelectorAll(selector));
    const nodes = [];
    const lines = [];
    let totalBytes = 0;
    let truncated = candidates.length > MAX_DOM_NODES;

    for (const element of candidates) {
      if (nodes.length >= MAX_DOM_NODES) {
        truncated = true;
        break;
      }

      const scanId = ensureScanId(element);
      const role = implicitRole(element);
      const name = accessibleName(element) || null;
      const text = normalizeText(element.textContent, 500) || null;
      const testId = normalizeText(element.getAttribute("data-testid"), 256) || null;
      const inputType =
        element.tagName.toLowerCase() === "input"
          ? normalizeText(element.getAttribute("type") || "text", 64)
          : null;
      const href =
        element.tagName.toLowerCase() === "a"
          ? normalizeText(element.getAttribute("href"), 1000) || null
          : null;
      const node = {
        scanId,
        tag: element.tagName.toLowerCase(),
        role,
        name,
        text,
        testId,
        inputType,
        href,
        visible: isVisible(element),
        disabled: isDisabled(element),
        target: chooseTarget(element, scanId),
      };
      const line = formatDomNode(node);
      const lineBytes = encoder.encode(line + "\\n").byteLength;

      if (totalBytes + lineBytes > MAX_DOM_BYTES) {
        truncated = true;
        break;
      }

      nodes.push(node);
      lines.push(line);
      totalBytes += lineBytes;
    }

    return {
      revision: context.revision,
      sessionId: activeSessionId,
      nodes,
      summary: lines.join("\\n"),
      totalBytes,
      truncated,
    };
  }

  function resolveTarget(target) {
    let matches = [];
    try {
      if (!target || typeof target !== "object") {
        return {
          ok: false,
          error: { code: "invalid_command", message: "缺少合法的浏览器目标。" },
        };
      }

      if (target.strategy === "test_id" && typeof target.value === "string") {
        matches = Array.from(
          document.querySelectorAll(
            '[data-testid="' + escapeAttributeValue(target.value) + '"]',
          ),
        );
      } else if (
        target.strategy === "role_name" &&
        typeof target.role === "string" &&
        typeof target.name === "string"
      ) {
        matches = Array.from(document.querySelectorAll("*")).filter(
          (element) =>
            implicitRole(element) === target.role &&
            accessibleName(element) === target.name,
        );
      } else if (
        target.strategy === "css" &&
        typeof target.selector === "string"
      ) {
        matches = Array.from(document.querySelectorAll(target.selector));
      } else if (
        target.strategy === "scan_id" &&
        typeof target.id === "string"
      ) {
        matches = Array.from(
          document.querySelectorAll(
            "[" + SCAN_ID_ATTRIBUTE + '="' + escapeAttributeValue(target.id) + '"]',
          ),
        );
      } else {
        return {
          ok: false,
          error: { code: "invalid_command", message: "浏览器目标策略不受支持。" },
        };
      }
    } catch {
      return {
        ok: false,
        error: { code: "invalid_command", message: "浏览器目标选择器无效。" },
      };
    }

    if (matches.length === 0) {
      return {
        ok: false,
        error: { code: "target_not_found", message: "没有找到目标元素。" },
      };
    }
    if (matches.length > 1) {
      // 歧义目标必须失败，不能依赖 DOM 顺序随机点击第一个匹配项。
      return {
        ok: false,
        error: {
          code: "target_ambiguous",
          message: "目标匹配到 " + matches.length + " 个元素，请使用更稳定的定位方式。",
        },
      };
    }

    return { ok: true, element: matches[0] };
  }

  function boundedTimeout(value) {
    return Math.min(
      5000,
      Math.max(100, Number.isFinite(value) ? Math.floor(value) : DEFAULT_STEP_TIMEOUT_MS),
    );
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function waitUntil(check, timeoutMs) {
    const startedAt = Date.now();
    let latestFailure = null;

    while (Date.now() - startedAt <= timeoutMs) {
      const result = check();
      if (result.ok) {
        return result;
      }
      if (
        result.error &&
        ["invalid_command", "target_ambiguous"].includes(result.error.code)
      ) {
        return result;
      }
      latestFailure = result;
      await delay(50);
    }

    return {
      ok: false,
      error: {
        code: "timeout",
        message:
          (latestFailure && latestFailure.error && latestFailure.error.message
            ? latestFailure.error.message + " "
            : "") + "等待浏览器条件超时。",
      },
    };
  }

  function ensureActionable(element) {
    if (!isVisible(element)) {
      return {
        ok: false,
        error: { code: "target_not_visible", message: "目标元素当前不可见。" },
      };
    }
    if (isDisabled(element)) {
      return {
        ok: false,
        error: { code: "action_failed", message: "目标元素当前不可用。" },
      };
    }
    return { ok: true, element };
  }

  function setNativeValue(element, value) {
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : null;
    const descriptor = prototype
      ? Object.getOwnPropertyDescriptor(prototype, "value")
      : null;

    if (!descriptor || typeof descriptor.set !== "function") {
      return false;
    }

    // React controlled input 监听原生 value setter 与冒泡事件。直接赋值可能只改 DOM，
    // 却没有同步组件状态，因此必须绕过实例覆写并连续派发 input/change。
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function createKeyboardEvent(type, key) {
    try {
      return new KeyboardEvent(type, {
        key,
        code: key.length === 1 ? "Key" + key.toUpperCase() : key,
        bubbles: true,
        cancelable: true,
      });
    } catch {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "key", { value: key });
      return event;
    }
  }

  function urlMatches(pattern) {
    const currentUrl = window.location.href;
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const lastSlash = pattern.lastIndexOf("/");
      try {
        return new RegExp(
          pattern.slice(1, lastSlash),
          pattern.slice(lastSlash + 1),
        ).test(currentUrl);
      } catch {
        return false;
      }
    }
    return currentUrl.includes(pattern);
  }

  async function executeStep(step) {
    const timeoutMs = boundedTimeout(step.timeoutMs);

    if (step.action === "wait_for" && !step.target) {
      await delay(timeoutMs);
      return { ok: true, message: "等待时间已结束。" };
    }

    if (step.action === "assert_url") {
      const result = await waitUntil(
        () =>
          urlMatches(step.pattern)
            ? { ok: true }
            : {
                ok: false,
                error: {
                  code: "assertion_failed",
                  message: "当前 URL 不匹配断言模式。",
                },
              },
        timeoutMs,
      );
      return result.ok
        ? { ok: true, message: "URL 断言通过。" }
        : result;
    }

    if (step.action === "assert_text" && !step.target) {
      const result = await waitUntil(
        () =>
          normalizeText(document.body && document.body.textContent, 100000).includes(
            step.text,
          )
            ? { ok: true }
            : {
                ok: false,
                error: {
                  code: "assertion_failed",
                  message: "页面中没有出现预期文本。",
                },
              },
        timeoutMs,
      );
      return result.ok
        ? { ok: true, message: "页面文本断言通过。" }
        : result;
    }

    if (step.action === "assert_text" && step.target) {
      const result = await waitUntil(() => {
        const resolved = resolveTarget(step.target);
        if (!resolved.ok) {
          return resolved;
        }

        return normalizeText(resolved.element.textContent, 100000).includes(
          step.text,
        )
          ? { ok: true, element: resolved.element }
          : {
              ok: false,
              error: {
                code: "assertion_failed",
                message: "目标元素不包含预期文本。",
              },
            };
      }, timeoutMs);
      return result.ok
        ? { ok: true, message: "目标文本断言通过。" }
        : result;
    }

    if (step.action === "press" && !step.target) {
      const keyboardTarget = document.activeElement || document.body;
      if (!keyboardTarget) {
        return {
          ok: false,
          error: { code: "target_not_found", message: "页面没有可接收按键的目标。" },
        };
      }
      keyboardTarget.dispatchEvent(createKeyboardEvent("keydown", step.key));
      keyboardTarget.dispatchEvent(createKeyboardEvent("keyup", step.key));
      return { ok: true, message: "按键事件已派发。" };
    }

    const targetResult = await waitUntil(
      () => {
        const resolved = resolveTarget(step.target);
        if (!resolved.ok) return resolved;
        if (step.action === "wait_for" || step.action === "assert_visible") {
          return isVisible(resolved.element)
            ? resolved
            : {
                ok: false,
                error: {
                  code: "target_not_visible",
                  message: "目标元素尚未可见。",
                },
              };
        }
        return resolved;
      },
      timeoutMs,
    );
    if (!targetResult.ok) {
      return targetResult;
    }

    const element = targetResult.element;
    if (step.action === "wait_for") {
      return { ok: true, message: "目标元素已出现。" };
    }
    if (step.action === "assert_visible") {
      return { ok: true, message: "可见性断言通过。" };
    }
    if (step.action === "click") {
      const actionable = ensureActionable(element);
      if (!actionable.ok) return actionable;
      if (typeof element.click !== "function") {
        return {
          ok: false,
          error: {
            code: "unsupported_element",
            message: "目标元素不支持 click。",
          },
        };
      }
      element.click();
      return { ok: true, message: "点击已执行。" };
    }
    if (step.action === "fill") {
      const actionable = ensureActionable(element);
      if (!actionable.ok) return actionable;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        return setNativeValue(element, step.value)
          ? { ok: true, message: "输入值已填写。" }
          : {
              ok: false,
              error: {
                code: "unsupported_element",
                message: "输入元素缺少可用的原生 value setter。",
              },
            };
      }
      if (element.isContentEditable) {
        element.textContent = step.value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, message: "可编辑区域已填写。" };
      }
      return {
        ok: false,
        error: {
          code: "unsupported_element",
          message: "fill 只支持 input、textarea 和 contenteditable。",
        },
      };
    }
    if (step.action === "select") {
      const actionable = ensureActionable(element);
      if (!actionable.ok) return actionable;
      if (!(element instanceof HTMLSelectElement)) {
        return {
          ok: false,
          error: {
            code: "unsupported_element",
            message: "select 只支持原生 select 元素。",
          },
        };
      }
      const optionExists = Array.from(element.options).some(
        (option) => option.value === step.value,
      );
      if (!optionExists) {
        return {
          ok: false,
          error: {
            code: "option_not_found",
            message: "目标 select 中不存在指定 value。",
          },
        };
      }
      element.value = step.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, message: "选项已选择。" };
    }
    if (step.action === "press") {
      element.dispatchEvent(createKeyboardEvent("keydown", step.key));
      element.dispatchEvent(createKeyboardEvent("keyup", step.key));
      return { ok: true, message: "按键事件已派发。" };
    }

    return {
      ok: false,
      error: { code: "invalid_command", message: "浏览器动作不受支持。" },
    };
  }

  async function executeSteps(steps) {
    const results = [];
    let failedStep = null;

    for (let index = 0; index < Math.min(steps.length, MAX_BROWSER_STEPS); index += 1) {
      const step = steps[index];
      const startedAt = Date.now();
      let outcome;
      try {
        outcome = await executeStep(step);
      } catch (error) {
        outcome = {
          ok: false,
          error: {
            code: "action_failed",
            message: normalizeText(error && error.message ? error.message : error, 2048),
          },
        };
      }

      const passed = outcome.ok === true;
      results.push({
        index,
        action: step.action,
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        target: step.target || null,
        status: passed ? "passed" : "failed",
        message: passed ? outcome.message : outcome.error.message,
        error: passed ? null : outcome.error,
      });

      if (!passed) {
        failedStep = index;
        break;
      }
    }

    return {
      revision: context.revision,
      sessionId: activeSessionId,
      ok: failedStep === null,
      steps: results,
      failedStep,
      // 失败现场与动作结果绑定同一 revision，后续 Agent 不需要猜测页面当时状态。
      domContext: failedStep === null ? null : scanDom(),
    };
  }

  function sanitizeNetworkUrl(input) {
    try {
      const url = new URL(String(input), window.location.href);
      return {
        origin: normalizeText(url.origin, 500),
        path: normalizeText(url.pathname || "/", 1000),
        // 查询参数只暴露键名，不保留 token、邮箱、搜索词等任意值。
        queryKeys: Array.from(new Set(Array.from(url.searchParams.keys())))
          .sort()
          .slice(0, 20)
          .map((key) => normalizeText(key, 200)),
      };
    } catch {
      return {
        origin: "",
        path: normalizeText(input, 1000),
        queryKeys: [],
      };
    }
  }

  function addNetworkEntry(entry) {
    if (!activeSessionId) {
      return;
    }
    if (networkEntries.length >= MAX_NETWORK_ENTRIES) {
      networkTruncated = true;
      return;
    }

    const bytes = encoder.encode(JSON.stringify(entry)).byteLength;
    if (networkBytes + bytes > MAX_NETWORK_BYTES) {
      networkTruncated = true;
      return;
    }

    networkEntries.push(entry);
    networkBytes += bytes;
  }

  function recordNetwork(input) {
    addNetworkEntry({
      requestType: input.requestType,
      method: normalizeText(input.method || "GET", 20).toUpperCase(),
      status: Number.isInteger(input.status) ? input.status : null,
      durationMs: Math.max(0, Math.min(300000, Math.round(input.durationMs || 0))),
      timestamp: Date.now(),
      url: sanitizeNetworkUrl(input.url),
      failed:
        input.failed === true ||
        !Number.isInteger(input.status) ||
        input.status === 0 ||
        input.status >= 400,
      error: input.error ? normalizeText(input.error, 1000) : null,
    });
  }

  const originalFetch =
    typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = async (input, init) => {
      const startedAt = Date.now();
      const method =
        (init && init.method) ||
        (typeof Request !== "undefined" && input instanceof Request
          ? input.method
          : "GET");
      const url =
        typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : input;
      try {
        const response = await originalFetch(input, init);
        recordNetwork({
          requestType: "fetch",
          method,
          status: response.status,
          durationMs: Date.now() - startedAt,
          url,
        });
        return response;
      } catch (error) {
        recordNetwork({
          requestType: "fetch",
          method,
          status: null,
          durationMs: Date.now() - startedAt,
          url,
          failed: true,
          error: error && error.message ? error.message : error,
        });
        throw error;
      }
    };
  }

  const xhrMetadata = new WeakMap();
  if (
    typeof XMLHttpRequest !== "undefined" &&
    XMLHttpRequest.prototype &&
    typeof XMLHttpRequest.prototype.open === "function" &&
    typeof XMLHttpRequest.prototype.send === "function"
  ) {
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      xhrMetadata.set(this, {
        method,
        url,
        startedAt: 0,
        recorded: false,
      });
      return originalXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const metadata = xhrMetadata.get(this) || {
        method: "GET",
        url: "",
        startedAt: 0,
        recorded: false,
      };
      metadata.startedAt = Date.now();
      xhrMetadata.set(this, metadata);

      const finalize = (error) => {
        if (metadata.recorded) return;
        metadata.recorded = true;
        recordNetwork({
          requestType: "xhr",
          method: metadata.method,
          status: Number.isInteger(this.status) ? this.status : null,
          durationMs: Date.now() - metadata.startedAt,
          url: metadata.url,
          failed: Boolean(error),
          error,
        });
      };
      this.addEventListener("loadend", () => finalize(null), { once: true });
      this.addEventListener("error", () => finalize("XHR network error"), {
        once: true,
      });
      this.addEventListener("timeout", () => finalize("XHR timeout"), {
        once: true,
      });
      this.addEventListener("abort", () => finalize("XHR aborted"), {
        once: true,
      });

      // body 只透传给原生 XHR，从不读取、序列化或写入 Evidence。
      return originalXhrSend.call(this, body);
    };
  }

  function getNetworkEvidence(includeSuccessful) {
    const entries = includeSuccessful
      ? networkEntries
      : networkEntries.filter((entry) => entry.failed);
    return {
      revision: context.revision,
      sessionId: activeSessionId,
      entries,
      totalBytes: networkBytes,
      truncated: networkTruncated,
      includesSuccessful: includeSuccessful,
    };
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function hasOnlyKeys(value, allowed) {
    const keys = Object.keys(value);
    return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
  }

  function isValidTarget(target) {
    if (!isPlainObject(target) || typeof target.strategy !== "string") {
      return false;
    }
    if (target.strategy === "test_id") {
      return hasOnlyKeys(target, ["strategy", "value"]) && typeof target.value === "string";
    }
    if (target.strategy === "role_name") {
      return (
        hasOnlyKeys(target, ["strategy", "role", "name"]) &&
        typeof target.role === "string" &&
        typeof target.name === "string"
      );
    }
    if (target.strategy === "css") {
      return hasOnlyKeys(target, ["strategy", "selector"]) && typeof target.selector === "string";
    }
    if (target.strategy === "scan_id") {
      return hasOnlyKeys(target, ["strategy", "id"]) && typeof target.id === "string";
    }
    return false;
  }

  function isValidTimeout(value, required) {
    return (
      (!required && value === undefined) ||
      (Number.isInteger(value) && value >= 100 && value <= 5000)
    );
  }

  function isValidStep(step) {
    if (!isPlainObject(step) || typeof step.action !== "string") {
      return false;
    }
    if (["click", "assert_visible"].includes(step.action)) {
      return (
        Object.keys(step).every((key) => ["action", "target", "timeoutMs"].includes(key)) &&
        isValidTarget(step.target) &&
        isValidTimeout(step.timeoutMs, false)
      );
    }
    if (["fill", "select"].includes(step.action)) {
      return (
        Object.keys(step).every((key) =>
          ["action", "target", "timeoutMs", "value"].includes(key),
        ) &&
        isValidTarget(step.target) &&
        typeof step.value === "string" &&
        isValidTimeout(step.timeoutMs, false)
      );
    }
    if (step.action === "press") {
      return (
        Object.keys(step).every((key) =>
          ["action", "target", "key", "timeoutMs"].includes(key),
        ) &&
        (step.target === undefined || isValidTarget(step.target)) &&
        typeof step.key === "string" &&
        step.key.length > 0 &&
        isValidTimeout(step.timeoutMs, false)
      );
    }
    if (step.action === "wait_for") {
      return (
        Object.keys(step).every((key) => ["action", "target", "timeoutMs"].includes(key)) &&
        (step.target === undefined || isValidTarget(step.target)) &&
        isValidTimeout(step.timeoutMs, true)
      );
    }
    if (step.action === "assert_text") {
      return (
        Object.keys(step).every((key) =>
          ["action", "target", "text", "timeoutMs"].includes(key),
        ) &&
        (step.target === undefined || isValidTarget(step.target)) &&
        typeof step.text === "string" &&
        isValidTimeout(step.timeoutMs, false)
      );
    }
    if (step.action === "assert_url") {
      return (
        Object.keys(step).every((key) =>
          ["action", "pattern", "timeoutMs"].includes(key),
        ) &&
        typeof step.pattern === "string" &&
        step.pattern.length > 0 &&
        isValidTimeout(step.timeoutMs, false)
      );
    }
    return false;
  }

  function validateCommand(command) {
    if (!isPlainObject(command) || typeof command.name !== "string") {
      return false;
    }
    if (["start_session", "scan_dom", "end_session"].includes(command.name)) {
      return hasOnlyKeys(command, ["name"]);
    }
    if (command.name === "execute_steps") {
      return (
        hasOnlyKeys(command, ["name", "steps"]) &&
        Array.isArray(command.steps) &&
        command.steps.length > 0 &&
        command.steps.length <= MAX_BROWSER_STEPS &&
        command.steps.every(isValidStep)
      );
    }
    if (command.name === "get_network") {
      return (
        Object.keys(command).every((key) =>
          ["name", "includeSuccessful"].includes(key),
        ) &&
        (command.includeSuccessful === undefined ||
          typeof command.includeSuccessful === "boolean")
      );
    }
    return false;
  }

  function isBrowserRequest(data) {
    return (
      isPlainObject(data) &&
      hasOnlyKeys(data, [
        "channel",
        "version",
        "runId",
        "revision",
        "type",
        "requestId",
        "sessionId",
        "command",
      ]) &&
      data.channel === context.channel &&
      data.version === context.version &&
      data.runId === context.runId &&
      data.revision === context.revision &&
      data.type === ${serializedBrowserRequestType} &&
      typeof data.requestId === "string" &&
      data.requestId.length > 0 &&
      typeof data.sessionId === "string" &&
      data.sessionId.length > 0
    );
  }

  async function handleBrowserRequest(data, targetOrigin) {
    const knownCommandNames = [
      "start_session",
      "scan_dom",
      "execute_steps",
      "get_network",
      "end_session",
    ];
    const commandName =
      isPlainObject(data.command) &&
      typeof data.command.name === "string" &&
      knownCommandNames.includes(data.command.name)
        ? data.command.name
        : "start_session";
    if (!validateCommand(data.command)) {
      postBrowserResponse(
        data,
        {
          commandName,
          ok: false,
          error: { code: "invalid_command", message: "Browser command 不符合严格协议。" },
        },
        targetOrigin,
      );
      return;
    }

    if (data.command.name === "start_session") {
      beginSession(data.sessionId);
      postBrowserResponse(
        data,
        {
          commandName: "start_session",
          ok: true,
          result: { started: true },
        },
        targetOrigin,
      );
      return;
    }

    if (activeSessionId !== data.sessionId) {
      postBrowserResponse(
        data,
        {
          commandName: data.command.name,
          ok: false,
          error: {
            code: "session_inactive",
            message: "Browser verification session 尚未启动或已经失效。",
          },
        },
        targetOrigin,
      );
      return;
    }

    if (data.command.name === "scan_dom") {
      postBrowserResponse(
        data,
        { commandName: "scan_dom", ok: true, result: scanDom() },
        targetOrigin,
      );
      return;
    }
    if (data.command.name === "execute_steps") {
      postBrowserResponse(
        data,
        {
          commandName: "execute_steps",
          ok: true,
          result: await executeSteps(data.command.steps),
        },
        targetOrigin,
      );
      return;
    }
    if (data.command.name === "get_network") {
      postBrowserResponse(
        data,
        {
          commandName: "get_network",
          ok: true,
          result: getNetworkEvidence(data.command.includeSuccessful === true),
        },
        targetOrigin,
      );
      return;
    }
    if (data.command.name === "end_session") {
      postBrowserResponse(
        data,
        {
          commandName: "end_session",
          ok: true,
          result: { ended: true },
        },
        targetOrigin,
      );
      endSession();
    }
  }

  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      post(level === "warn" ? "CONSOLE_WARN" : "CONSOLE_ERROR", {
        arguments: args.map(serialize),
        timestamp: Date.now(),
      });
    };
  }

  window.addEventListener("error", (event) => {
    post("RUNTIME_ERROR", {
      message: event.message || "Unknown runtime error",
      stack: event.error instanceof Error ? event.error.stack : undefined,
      timestamp: Date.now(),
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    post("UNHANDLED_REJECTION", {
      message:
        reason instanceof Error
          ? reason.message
          : serialize(reason || "Unknown unhandled rejection"),
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: Date.now(),
    });
  });

  function reportRender(targetOrigin) {
    requestAnimationFrame(() => {
      post("RENDER_OK", { timestamp: Date.now() }, targetOrigin);
    });
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    const referrerOrigin = getReferrerOrigin();
    const validSourceAndOrigin =
      event.source !== window.parent ||
      (referrerOrigin && event.origin !== referrerOrigin);
    if (validSourceAndOrigin) {
      return;
    }

    if (isBrowserRequest(data)) {
      void handleBrowserRequest(data, event.origin);
      return;
    }

    if (
      !isPlainObject(data) ||
      !hasOnlyKeys(data, ["channel", "version", "runId", "revision", "type"]) ||
      data.channel !== context.channel ||
      data.version !== context.version ||
      data.runId !== context.runId ||
      data.revision !== context.revision ||
      data.type !== ${serializedProbeType}
    ) {
      return;
    }

    // 初次 RENDER_OK 可能早于宿主监听器注册。探测协议允许宿主在观察窗口内
    // 重放确认，同时仍把响应严格限制到当前父窗口、Run 和 revision。
    reportRender(event.origin);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => reportRender(), { once: true });
  } else {
    reportRender();
  }
})();`;
}
