import type { CodeCompletionTrigger } from "@/domains/code-completion/types";

const OUTPUT_LIMITS = {
  automatic: {
    maxCharacters: 1_600,
    maxLines: 12,
    maxOutputTokens: 256,
  },
  explicit: {
    maxCharacters: 6_000,
    maxLines: 40,
    maxOutputTokens: 1_024,
  },
} as const satisfies Record<
  CodeCompletionTrigger,
  {
    maxCharacters: number;
    maxLines: number;
    maxOutputTokens: number;
  }
>;

export function getCodeCompletionOutputLimits(
  trigger: CodeCompletionTrigger,
) {
  return OUTPUT_LIMITS[trigger];
}

/**
 * 模型输出永远不直接交给 Monaco。这里依次剥离常见包装、去掉重复前缀，
 * 再执行行数与字符硬限制；超过限制时返回空建议，避免截断出语法残片。
 */
export function sanitizeCodeCompletion(input: {
  rawText: string;
  prefix: string;
  suffix: string;
  trigger: CodeCompletionTrigger;
}): string {
  const limits = getCodeCompletionOutputLimits(input.trigger);
  let text = normalizeLineEndings(input.rawText).trimEnd();

  text = unwrapJsonInsertText(text);
  text = unwrapMarkdownFence(text);
  text = removeRepeatedPrefix(text, input.prefix);
  text = removeRepeatedSuffix(text, input.suffix);

  if (
    text.includes("```") ||
    text.length > limits.maxCharacters ||
    countLines(text) > limits.maxLines
  ) {
    return "";
  }

  return text;
}

function unwrapJsonInsertText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "insertText" in parsed &&
      typeof parsed.insertText === "string"
    ) {
      return parsed.insertText;
    }
  } catch {
    // 非法 JSON 可能只是合法代码以 “{” 开头，继续按原始代码处理。
  }

  return value;
}

function unwrapMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match?.[1] ?? value;
}

function removeRepeatedPrefix(value: string, prefix: string): string {
  const comparablePrefix = prefix.slice(-2_000);
  if (!comparablePrefix || !value.startsWith(comparablePrefix)) {
    return value;
  }

  return value.slice(comparablePrefix.length);
}

function removeRepeatedSuffix(value: string, suffix: string): string {
  const comparableSuffix = suffix.slice(0, 2_000);
  if (!comparableSuffix || !value.endsWith(comparableSuffix)) {
    return value;
  }

  return value.slice(0, -comparableSuffix.length);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function countLines(value: string): number {
  if (!value) {
    return 0;
  }

  return value.split("\n").length;
}
