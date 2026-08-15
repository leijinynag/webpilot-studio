import { describe, expect, it } from "vitest";

import {
  getCodeCompletionOutputLimits,
  sanitizeCodeCompletion,
} from "@/domains/code-completion/sanitize";

describe("code completion sanitizer", () => {
  it("接受 JSON 或 Markdown 包装，并只返回可插入文本", () => {
    expect(
      sanitizeCodeCompletion({
        rawText: '{"insertText":"return value;"}',
        prefix: "",
        suffix: "",
        trigger: "automatic",
      }),
    ).toBe("return value;");

    expect(
      sanitizeCodeCompletion({
        rawText: "```ts\nconst ready = true;\n```",
        prefix: "",
        suffix: "",
        trigger: "automatic",
      }),
    ).toBe("const ready = true;");
  });

  it("移除模型重复返回的光标前后文本", () => {
    expect(
      sanitizeCodeCompletion({
        rawText: "const value = build();\nreturn value;\n}",
        prefix: "const value = build();\n",
        suffix: "\n}",
        trigger: "explicit",
      }),
    ).toBe("return value;");
  });

  it("拒绝超过自动触发行数或字符限制的结果", () => {
    const limits = getCodeCompletionOutputLimits("automatic");

    expect(
      sanitizeCodeCompletion({
        rawText: Array.from({ length: limits.maxLines + 1 }, () => "line").join(
          "\n",
        ),
        prefix: "",
        suffix: "",
        trigger: "automatic",
      }),
    ).toBe("");
    expect(
      sanitizeCodeCompletion({
        rawText: "x".repeat(limits.maxCharacters + 1),
        prefix: "",
        suffix: "",
        trigger: "automatic",
      }),
    ).toBe("");
  });
});
