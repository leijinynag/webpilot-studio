"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";

import type { WorkspaceFile } from "@/domains/project/workspace";
import { loadLocalMonacoReact } from "@/components/workbench/monaco-client";
import { useUiI18n } from "@/infrastructure/i18n/ui";

const MonacoEditor = dynamic(
  () => loadLocalMonacoReact().then((module) => module.Editor),
  {
    ssr: false,
    loading: () => <EditorLoading />,
  },
);

function EditorLoading() {
  const { t } = useUiI18n();
  return <div className="editor-loading">{t("workbench.editorLoading")}</div>;
}

export function CodeEditor({
  file,
  onChange,
  onEditorReady,
  onSave,
}: {
  file: WorkspaceFile;
  onChange: (content: string) => void;
  onEditorReady: (editor: editor.IStandaloneCodeEditor | null) => void;
  onSave: () => void;
}) {
  const saveRef = useRef(onSave);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  return (
    <MonacoEditor
      beforeMount={(monaco) => {
        monaco.editor.defineTheme("webpilot-light", {
          base: "vs",
          inherit: true,
          rules: [],
          colors: {
            "editor.background": "#f7f4ed",
            "editor.foreground": "#25221e",
            "editorLineNumber.foreground": "#9b9488",
            "editorLineNumber.activeForeground": "#554f47",
            "editor.selectionBackground": "#d9c4b8",
            "editor.inactiveSelectionBackground": "#e7ddd6",
            "editorIndentGuide.background1": "#ded8cd",
          },
        });
        monaco.editor.defineTheme("webpilot-dark", {
          base: "vs-dark",
          inherit: true,
          rules: [],
          colors: {
            "editor.background": "#08090a",
            "editor.foreground": "#ececea",
            "editorLineNumber.foreground": "#55595e",
            "editorLineNumber.activeForeground": "#b9b7b2",
            "editor.selectionBackground": "#463126",
            "editor.inactiveSelectionBackground": "#2a211d",
            "editorIndentGuide.background1": "#1d2023",
          },
        });
      }}
      height="100%"
      language={getMonacoLanguage(file.path)}
      onChange={(value) => onChange(value ?? "")}
      onMount={(mountedEditor, monaco) => {
        onEditorReady(mountedEditor);
        mountedEditor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
          () => saveRef.current(),
        );

        const applyTheme = () => {
          monaco.editor.setTheme(
            document.documentElement.dataset.theme === "dark"
              ? "webpilot-dark"
              : "webpilot-light",
          );
        };
        applyTheme();

        // 主题切换只改变根节点属性。监听该属性即可同步 Monaco，
        // 无需让大型编辑器因为主题状态重新挂载并丢失光标位置。
        const observer = new MutationObserver(applyTheme);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        mountedEditor.onDidDispose(() => {
          observer.disconnect();
          onEditorReady(null);
        });
      }}
      options={{
        accessibilitySupport: "auto",
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        fontFamily:
          '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontLigatures: true,
        fontSize: 14,
        lineHeight: 22,
        minimap: { enabled: false },
        padding: { top: 14, bottom: 14 },
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: "on",
      }}
      path={file.path}
      saveViewState
      value={file.draftContent}
    />
  );
}

export function getMonacoLanguage(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();

  return (
    {
      css: "css",
      html: "html",
      js: "javascript",
      json: "json",
      jsx: "javascript",
      md: "markdown",
      scss: "scss",
      ts: "typescript",
      tsx: "typescript",
    }[extension ?? ""] ?? "plaintext"
  );
}
