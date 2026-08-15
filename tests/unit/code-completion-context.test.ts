import { describe, expect, it } from "vitest";

import {
  buildCodeCompletionMessages,
  buildCodeCompletionPromptContext,
  extractImportSpecifiers,
} from "@/domains/code-completion/context";
import type { CodeCompletionRequest } from "@/domains/code-completion/types";

const request: CodeCompletionRequest = {
  clientRequestId: "11111111-1111-4111-8111-111111111111",
  projectRevision: 7,
  path: "src/components/card.tsx",
  language: "typescript",
  position: { lineNumber: 8, column: 4 },
  prefix: [
    'import { formatTitle } from "../utils/format";',
    'import type { CardProps } from "../types";',
    "",
    "export function Card(props: CardProps) {",
    "  const title = formatTitle(props.title);",
    "  ",
  ].join("\n"),
  suffix: "\n}",
  trigger: "automatic",
};

describe("code completion context", () => {
  it("解析相对 import，并把相关文件正文、package.json 和索引加入上下文", () => {
    const context = buildCodeCompletionPromptContext(request, [
      { path: "src/components/card.tsx", content: request.prefix },
      {
        path: "src/utils/format.ts",
        content: "export const formatTitle = (value: string) => value.trim();",
      },
      {
        path: "src/types/index.ts",
        content: "export type CardProps = { title: string };",
      },
      {
        path: "package.json",
        content: '{"dependencies":{"react":"19.2.4"}}',
      },
    ]);

    expect(context.relatedFiles.map((file) => file.path)).toEqual([
      "src/utils/format.ts",
      "src/types/index.ts",
    ]);
    expect(context.packageJson?.content).toContain('"react"');
    expect(context.projectFileIndex).toContain("src/components/card.tsx");
    expect(context.styleHint).toContain("2 spaces");

    const messages = buildCodeCompletionMessages({ request, context });
    expect(messages[0]?.content).toContain("at most 12 lines");
    expect(messages[1]?.content).toContain("src/utils/format.ts");
    expect(messages[1]?.content).toContain("formatTitle");
  });

  it("只提取相对模块，忽略第三方包名", () => {
    expect(
      extractImportSpecifiers(
        [
          'import React from "react";',
          'export { value } from "./value";',
          'const lazy = import("../lazy");',
          'const config = require("./config");',
        ].join("\n"),
      ),
    ).toEqual(["./value", "../lazy", "./config"]);
  });
});
