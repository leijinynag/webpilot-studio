import type { FileSystemTree } from "@webcontainer/api";

import {
  RUNTIME_BRIDGE_CHANNEL,
  RUNTIME_BRIDGE_PROBE_TYPE,
  RUNTIME_BRIDGE_VERSION,
} from "@/domains/agent/evidence";

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

function createRuntimeBridgeScript(context: RuntimeBridgeContext): string {
  const serializedContext = JSON.stringify({
    channel: RUNTIME_BRIDGE_CHANNEL,
    version: RUNTIME_BRIDGE_VERSION,
    runId: context.runId,
    revision: context.revision,
  });
  const serializedProbeType = JSON.stringify(RUNTIME_BRIDGE_PROBE_TYPE);

  return `(() => {
  "use strict";

  const context = ${serializedContext};
  const MAX_ENTRY_BYTES = 2048;
  const MAX_DEPTH = 5;
  const encoder = new TextEncoder();

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
    if (
      event.source !== window.parent ||
      (referrerOrigin && event.origin !== referrerOrigin) ||
      !data ||
      typeof data !== "object" ||
      Object.keys(data).length !== 5 ||
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
