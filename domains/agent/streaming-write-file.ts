import {
  FILE_TOOL_NAMES,
  FILE_TOOL_SCHEMAS,
} from "@/domains/agent/tool-contracts";
import { assertValidProjectPath } from "@/domains/project/path";

export type StreamingWriteFileEvent =
  | {
      type: "file.stream_started";
      payload: {
        toolCallId: string;
        path: string;
      };
    }
  | {
      type: "file.stream_delta";
      payload: {
        toolCallId: string;
        path: string;
        text: string;
      };
    }
  | {
      type: "file.stream_completed";
      payload: {
        toolCallId: string;
        path: string;
        characterCount: number;
      };
    }
  | {
      type: "file.stream_discarded";
      payload: {
        toolCallId: string;
        path?: string;
        reason: string;
      };
    };

export type StreamingWriteFileProjection = {
  path: string | null;
  emittedContent: string;
  emittedCharacterCount: number;
  status: "pending" | "streaming" | "completed" | "discarded";
};

type ParsedJsonString = {
  complete: boolean;
  endIndex: number;
  value: string;
};

type InspectedArguments = {
  content: ParsedJsonString | null;
  invalidReason: string | null;
  path: ParsedJsonString | null;
};

export function createStreamingWriteFileProjection(): StreamingWriteFileProjection {
  return {
    path: null,
    emittedContent: "",
    emittedCharacterCount: 0,
    status: "pending",
  };
}

/**
 * Provider 的函数参数是被任意 chunk 切开的 JSON 文本，不能对每个 chunk
 * 直接 JSON.parse。这里每次只投影已经确定属于 path/content 字符串的前缀：
 * 未闭合转义、半个 unicode 序列、未知字段和值都不会泄漏到编辑器。
 *
 * 解析器会从当前累计文本重新扫描，状态只记录已经向客户端发布的字符数量。
 * write_file 的参数上限为 1MB，这个 O(n) 扫描换来了简单、可审计的安全边界，
 * 同时避免在跨 chunk 状态机中错误拼接转义字符。
 */
export function updateStreamingWriteFileProjection(input: {
  projection: StreamingWriteFileProjection;
  toolCallId: string;
  toolName: string;
  argumentsText: string;
}): StreamingWriteFileEvent[] {
  const { projection } = input;
  if (
    projection.status === "completed" ||
    projection.status === "discarded" ||
    input.toolName !== FILE_TOOL_NAMES.writeFile ||
    input.toolCallId.length === 0
  ) {
    return [];
  }

  const inspected = inspectWriteFileArguments(input.argumentsText);
  if (inspected.invalidReason) {
    return discardStreamingWriteFileProjection({
      projection,
      toolCallId: input.toolCallId,
      reason: inspected.invalidReason,
    });
  }

  if (!inspected.path?.complete) {
    return [];
  }

  let path: string;
  try {
    // 正式 Tool Schema 会 trim path；临时标签也使用相同规范化结果，
    // 防止落库后因为首尾空格变化出现两个看似不同的标签。
    path = assertValidProjectPath(inspected.path.value.trim());
  } catch {
    return discardStreamingWriteFileProjection({
      projection,
      toolCallId: input.toolCallId,
      reason: "invalid_path",
    });
  }

  if (projection.path !== null && projection.path !== path) {
    return discardStreamingWriteFileProjection({
      projection,
      toolCallId: input.toolCallId,
      reason: "path_changed",
    });
  }

  const events: StreamingWriteFileEvent[] = [];
  if (projection.status === "pending") {
    projection.path = path;
    projection.status = "streaming";
    events.push({
      type: "file.stream_started",
      payload: { toolCallId: input.toolCallId, path },
    });
  }

  const content = inspected.content?.value ?? "";
  // Provider 的累计参数理论上只能追加，但代理层、重试层或不兼容供应商可能
  // 在相同 Tool Call 上改写先前字符。临时编辑器已经展示的内容不能被静默
  // 篡改；一旦前缀不再一致，立即回收投影并等待正式工具结果。
  if (!content.startsWith(projection.emittedContent)) {
    return [
      ...events,
      ...discardStreamingWriteFileProjection({
        projection,
        toolCallId: input.toolCallId,
        reason: "content_prefix_changed",
      }),
    ];
  }

  if (content.length > projection.emittedCharacterCount) {
    const text = content.slice(projection.emittedCharacterCount);
    projection.emittedContent = content;
    projection.emittedCharacterCount = content.length;
    events.push({
      type: "file.stream_delta",
      payload: { toolCallId: input.toolCallId, path, text },
    });
  }

  return events;
}

/**
 * 只有 Provider 流正常结束，并且完整参数通过正式 write_file Schema 后，
 * 才把临时投影标记为 completed。completed 仍不代表文件已经写入 Repository；
 * 前端必须继续等待 tool.completed/client_tool.completed 的真实执行结果。
 */
export function completeStreamingWriteFileProjection(input: {
  projection: StreamingWriteFileProjection;
  toolCallId: string;
  toolName: string;
  argumentsText: string;
}): StreamingWriteFileEvent[] {
  const { projection } = input;
  if (
    projection.status === "completed" ||
    projection.status === "discarded" ||
    input.toolName !== FILE_TOOL_NAMES.writeFile ||
    input.toolCallId.length === 0
  ) {
    return [];
  }

  const events = updateStreamingWriteFileProjection(input);
  if (events.some((event) => event.type === "file.stream_discarded")) {
    return events;
  }

  let argumentsJson: unknown;
  try {
    argumentsJson = JSON.parse(input.argumentsText);
  } catch {
    return [
      ...events,
      ...discardStreamingWriteFileProjection({
        projection,
        toolCallId: input.toolCallId,
        reason: "invalid_json",
      }),
    ];
  }

  const parsed = FILE_TOOL_SCHEMAS.write_file.safeParse(argumentsJson);
  if (!parsed.success) {
    return [
      ...events,
      ...discardStreamingWriteFileProjection({
        projection,
        toolCallId: input.toolCallId,
        reason: "invalid_arguments",
      }),
    ];
  }

  if (
    projection.status !== "streaming" ||
    projection.path !== parsed.data.path
  ) {
    return [
      ...events,
      ...discardStreamingWriteFileProjection({
        projection,
        toolCallId: input.toolCallId,
        reason: "projection_mismatch",
      }),
    ];
  }

  projection.status = "completed";
  events.push({
    type: "file.stream_completed",
    payload: {
      toolCallId: input.toolCallId,
      path: projection.path,
      characterCount: parsed.data.content.length,
    },
  });
  return events;
}

export function discardStreamingWriteFileProjection(input: {
  projection: StreamingWriteFileProjection;
  toolCallId: string;
  reason: string;
}): StreamingWriteFileEvent[] {
  if (input.projection.status === "discarded") {
    return [];
  }

  const path = input.projection.path;
  // completed 只表示模型参数已闭合，真实 Repository 写入仍可能失败。
  // 因此前端可见的 streaming/completed 两种状态都必须允许被正式结果回收。
  const wasVisible =
    input.projection.status === "streaming" ||
    input.projection.status === "completed";
  input.projection.status = "discarded";

  // 尚未拿到安全路径时，前端从未创建临时标签，不需要发送一条无对象可回收的
  // discarded 事件。服务端仍会通过正式工具错误记录诊断失败原因。
  if (!wasVisible) {
    return [];
  }

  return [
    {
      type: "file.stream_discarded",
      payload: {
        toolCallId: input.toolCallId,
        ...(path ? { path } : {}),
        reason: input.reason,
      },
    },
  ];
}

function inspectWriteFileArguments(text: string): InspectedArguments {
  let index = skipWhitespace(text, 0);
  if (index >= text.length) {
    return { path: null, content: null, invalidReason: null };
  }
  if (text[index] !== "{") {
    return { path: null, content: null, invalidReason: "invalid_json_shape" };
  }

  index += 1;
  let path: ParsedJsonString | null = null;
  let content: ParsedJsonString | null = null;
  const observedKeys = new Set<string>();

  while (index < text.length) {
    index = skipWhitespace(text, index);
    if (index >= text.length || text[index] === "}") {
      break;
    }

    if (text[index] !== '"') {
      return { path, content, invalidReason: "invalid_property_name" };
    }
    const key = parseJsonString(text, index);
    if (!key.complete) {
      return { path, content, invalidReason: null };
    }
    index = skipWhitespace(text, key.endIndex);
    if (index >= text.length) {
      return { path, content, invalidReason: null };
    }
    if (text[index] !== ":") {
      return { path, content, invalidReason: "missing_property_colon" };
    }

    index = skipWhitespace(text, index + 1);
    if (index >= text.length) {
      return { path, content, invalidReason: null };
    }

    if (observedKeys.has(key.value)) {
      return {
        path,
        content,
        invalidReason:
          key.value === "path" || key.value === "content"
            ? `duplicate_${key.value}`
            : "duplicate_property",
      };
    }
    observedKeys.add(key.value);

    if (text[index] === '"') {
      const value = parseJsonString(text, index);
      if (key.value === "path") {
        path = value;
      } else if (key.value === "content") {
        content = value;
      }
      if (!value.complete) {
        return { path, content, invalidReason: null };
      }
      index = value.endIndex;
    } else {
      if (key.value === "path" || key.value === "content") {
        return {
          path,
          content,
          invalidReason: `${key.value}_must_be_string`,
        };
      }
      const skipped = skipJsonValue(text, index);
      if (skipped.invalid) {
        return { path, content, invalidReason: "invalid_property_value" };
      }
      if (!skipped.complete) {
        return { path, content, invalidReason: null };
      }
      index = skipped.endIndex;
    }

    index = skipWhitespace(text, index);
    if (index >= text.length || text[index] === "}") {
      break;
    }
    if (text[index] !== ",") {
      return { path, content, invalidReason: "missing_property_comma" };
    }
    index += 1;
  }

  return { path, content, invalidReason: null };
}

function parseJsonString(text: string, startIndex: number): ParsedJsonString {
  let index = startIndex + 1;
  let value = "";

  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      return { complete: true, endIndex: index + 1, value };
    }
    if (character === "\\") {
      if (index + 1 >= text.length) {
        return { complete: false, endIndex: text.length, value };
      }

      const escape = text[index + 1];
      const escapedCharacters: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (escape in escapedCharacters) {
        value += escapedCharacters[escape];
        index += 2;
        continue;
      }
      if (escape !== "u") {
        return { complete: false, endIndex: text.length, value };
      }

      const hex = text.slice(index + 2, index + 6);
      if (hex.length < 4) {
        return { complete: false, endIndex: text.length, value };
      }
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { complete: false, endIndex: text.length, value };
      }
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }

    if (character.charCodeAt(0) < 0x20) {
      return { complete: false, endIndex: text.length, value };
    }
    value += character;
    index += 1;
  }

  return { complete: false, endIndex: text.length, value };
}

function skipJsonValue(
  text: string,
  startIndex: number,
): { complete: boolean; endIndex: number; invalid: boolean } {
  let index = startIndex;
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      if (depth === 0) {
        return { complete: true, endIndex: index, invalid: false };
      }
      depth -= 1;
      index += 1;
      continue;
    }
    if (character === "," && depth === 0) {
      return { complete: true, endIndex: index, invalid: false };
    }
    index += 1;
  }

  return {
    complete: !inString && depth === 0,
    endIndex: index,
    invalid: false,
  };
}

function skipWhitespace(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}
