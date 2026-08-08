import { describe, expect, it, vi } from "vitest";

import { configureMonacoDiagnostics } from "@/components/workbench/monaco-client";

describe("Monaco 客户端诊断策略", () => {
  it("保留语法诊断并关闭缺少项目类型图时的语义误报", () => {
    const setTypeScriptDiagnostics = vi.fn();
    const setJavaScriptDiagnostics = vi.fn();

    configureMonacoDiagnostics({
      languages: {
        typescript: {
          javascriptDefaults: {
            setDiagnosticsOptions: setJavaScriptDiagnostics,
          },
          typescriptDefaults: {
            setDiagnosticsOptions: setTypeScriptDiagnostics,
          },
        },
      },
    });

    const expectedOptions = {
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
      noSyntaxValidation: false,
    };
    expect(setTypeScriptDiagnostics).toHaveBeenCalledWith(expectedOptions);
    expect(setJavaScriptDiagnostics).toHaveBeenCalledWith(expectedOptions);
  });
});
