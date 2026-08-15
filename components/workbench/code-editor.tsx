"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import type { editor } from "monaco-editor";

import type { CodeCompletionSourceFile } from "@/domains/code-completion/types";
import type { ProjectStorageKind } from "@/domains/project/types";
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
  codeCompletion,
  file,
  onChange,
  onCompletionTriggerReady,
  onEditorReady,
  onSave,
}: {
  codeCompletion: {
    automaticEnabled: boolean;
    enabled: boolean;
    projectId: string;
    projectRevision: number;
    storageKind: ProjectStorageKind;
    getBrowserFiles: () => readonly CodeCompletionSourceFile[];
  };
  file: WorkspaceFile;
  onChange: (content: string) => void;
  onCompletionTriggerReady: (trigger: (() => void) | null) => void;
  onEditorReady: (editor: editor.IStandaloneCodeEditor | null) => void;
  onSave: () => void;
}) {
  const { t } = useUiI18n();
  const {
    automaticEnabled: automaticCompletionEnabled,
    enabled: completionEnabled,
    getBrowserFiles,
    projectId,
    projectRevision,
    storageKind,
  } = codeCompletion;
  const saveRef = useRef(onSave);
  const mountedEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const completionClientRef = useRef<
    | import("@/infrastructure/code-completion/client").CodeCompletionClient
    | null
  >(null);
  const completionSnapshotRef = useRef({
    ...codeCompletion,
    path: file.path,
  });
  const completionTriggerReadyRef = useRef(onCompletionTriggerReady);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    completionTriggerReadyRef.current = onCompletionTriggerReady;
  }, [onCompletionTriggerReady]);

  useEffect(() => {
    // Provider 读取 ref 而不是闭包中的旧 props。这样补全模块无需在每次输入
    // 后重新注册，同时 ref 写入发生在 commit 之后，符合 React 的纯渲染约束。
    completionSnapshotRef.current = {
      automaticEnabled: automaticCompletionEnabled,
      enabled: completionEnabled,
      getBrowserFiles,
      path: file.path,
      projectId,
      projectRevision,
      storageKind,
    };
  }, [
    automaticCompletionEnabled,
    completionEnabled,
    file.path,
    getBrowserFiles,
    projectId,
    projectRevision,
    storageKind,
  ]);

  useEffect(() => {
    mountedEditorRef.current?.updateOptions({
      inlineSuggest: { enabled: completionEnabled },
    });

    // 切换文件、Repository revision 或关闭功能时，正在等待的结果已经失去
    // 插入资格。主动取消可尽早释放网络和 Provider 等待，不只依赖返回后的校验。
    completionClientRef.current?.cancel(
      completionEnabled
        ? automaticCompletionEnabled
          ? "context_changed"
          : "automatic_disabled"
        : "disabled",
    );
  }, [
    automaticCompletionEnabled,
    completionEnabled,
    file.path,
    projectRevision,
  ]);

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
        mountedEditorRef.current = mountedEditor;
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

        let disposed = false;
        let completionRegistration:
          | import("@/infrastructure/code-completion/monaco-provider").MonacoCompletionRegistration
          | null = null;

        // 补全模块只在 Monaco 真正挂载后加载，避免工作台首屏和 Next.js SSR
        // 提前解析编辑器 Provider。高频请求协调器也只绑定当前编辑器生命周期。
        void Promise.all([
          import("@/infrastructure/code-completion/client"),
          import("@/infrastructure/code-completion/monaco-provider"),
        ])
          .then(([clientModule, providerModule]) => {
            if (disposed) {
              return;
            }

            const client = clientModule.createCodeCompletionClient();
            completionClientRef.current = client;
            completionRegistration =
              providerModule.registerMonacoCodeCompletion({
                monaco,
                editor: mountedEditor,
                client,
                getSnapshot: () => {
                  const snapshot = completionSnapshotRef.current;
                  return {
                    automaticEnabled: snapshot.automaticEnabled,
                    enabled: snapshot.enabled,
                    projectId: snapshot.projectId,
                    projectRevision: snapshot.projectRevision,
                    path: snapshot.path,
                    storageKind: snapshot.storageKind,
                    browserFiles:
                      snapshot.storageKind === "browser_git"
                        ? snapshot.getBrowserFiles()
                        : undefined,
                  };
                },
                metrics: clientModule.emitCodeCompletionMetric,
                actionLabel: t("workbench.codeCompletion.trigger"),
              });
            completionTriggerReadyRef.current(
              completionRegistration.triggerExplicit,
            );
            mountedEditor.updateOptions({
              inlineSuggest: {
                enabled: completionSnapshotRef.current.enabled,
              },
            });
          })
          .catch(() => {
            if (!disposed) {
              // 动态 chunk 加载失败时保持编辑器可用，只关闭本次补全注册。
              // 用户刷新或重新进入工作台后会自然重试，不让错误冒泡成页面崩溃。
              completionTriggerReadyRef.current(null);
              completionClientRef.current?.dispose();
              completionClientRef.current = null;
            }
          });

        // 主题切换只改变根节点属性。监听该属性即可同步 Monaco，
        // 无需让大型编辑器因为主题状态重新挂载并丢失光标位置。
        const observer = new MutationObserver(applyTheme);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        mountedEditor.onDidDispose(() => {
          disposed = true;
          completionTriggerReadyRef.current(null);
          for (const disposable of completionRegistration?.disposables ?? []) {
            disposable.dispose();
          }
          completionClientRef.current?.dispose();
          completionClientRef.current = null;
          mountedEditorRef.current = null;
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
        inlineSuggest: { enabled: completionEnabled },
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
