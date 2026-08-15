import type { IDisposable, Position, editor, languages } from "monaco-editor";

import {
  CODE_COMPLETION_LANGUAGES,
  type CodeCompletionLanguage,
  type CodeCompletionSourceFile,
  type CodeCompletionTrigger,
} from "@/domains/code-completion/types";
import type {
  CodeCompletionClient,
  CodeCompletionMetric,
  CodeCompletionMetricSink,
} from "@/infrastructure/code-completion/client";

const MAX_BROWSER_CONTEXT_FILES = 40;
const MAX_BROWSER_CONTEXT_FILE_CHARACTERS = 32_000;
const MAX_BROWSER_CONTEXT_CHARACTERS = 120_000;

type MonacoApi = typeof import("monaco-editor");

export type MonacoCompletionSnapshot = {
  automaticEnabled: boolean;
  enabled: boolean;
  projectId: string;
  projectRevision: number;
  path: string;
  storageKind: "database" | "browser_git";
  browserFiles?: readonly CodeCompletionSourceFile[];
};

type TrackedInlineCompletion = languages.InlineCompletion & {
  tracking: {
    accepted: boolean;
    id: string;
    partialAcceptedCharacters: number;
    path: string;
    projectId: string;
    projectRevision: number;
    requestId: string;
    shown: boolean;
    trigger: CodeCompletionTrigger;
    model: string;
  };
};

type TrackedInlineCompletions =
  languages.InlineCompletions<TrackedInlineCompletion>;

export type MonacoCompletionRegistration = {
  disposables: IDisposable[];
  triggerExplicit(): void;
};

/**
 * Provider 的安全边界在“结果返回后”再校验一次：Monaco model version 保护
 * 未保存草稿，Repository revision 保护保存/Agent mutation，client generation
 * 保护更晚发起的请求。任意一层变化都只能丢弃结果，绝不能静默插入旧代码。
 */
export function registerMonacoCodeCompletion(input: {
  monaco: MonacoApi;
  editor: editor.IStandaloneCodeEditor;
  client: CodeCompletionClient;
  getSnapshot: () => MonacoCompletionSnapshot;
  metrics: CodeCompletionMetricSink;
  actionLabel: string;
}): MonacoCompletionRegistration {
  const acceptCommandId = `webpilot.codeCompletion.accept.${crypto.randomUUID()}`;
  const trackedItems = new Map<string, TrackedInlineCompletion>();
  const provider = createMonacoInlineCompletionProvider(input);
  const triggerExplicit = () => {
    // 工具栏菜单、设置弹层等外部控件会暂时夺走 Monaco 的焦点。显式命令
    // 只有在编辑器重新成为活动控件后才会稳定启动 Inline Completions；
    // 自动补全本身由输入事件触发，不需要经过这条焦点恢复路径。
    input.editor.focus();
    input.editor.trigger(
      "webpilot.codeCompletion",
      "editor.action.inlineSuggest.trigger",
      null,
    );
  };
  const disposables = CODE_COMPLETION_LANGUAGES.map((language) =>
    input.monaco.languages.registerInlineCompletionsProvider(
      language,
      provider,
    ),
  );

  disposables.push(
    input.monaco.editor.registerCommand(
      acceptCommandId,
      (_accessor, trackingId: string | undefined) => {
        const item = trackingId ? trackedItems.get(trackingId) : undefined;
        if (!item || item.tracking.accepted) {
          return;
        }
        item.tracking.accepted = true;
        input.metrics(createLifecycleMetric(item, "accepted"));
      },
    ),
  );
  disposables.push({
    dispose() {
      trackedItems.clear();
    },
  });

  const explicitAction = input.editor.addAction({
    id: "webpilot.codeCompletion.trigger",
    label: input.actionLabel,
    keybindings: [
      input.monaco.KeyMod.CtrlCmd |
        input.monaco.KeyMod.Alt |
        input.monaco.KeyCode.Space,
    ],
    run: triggerExplicit,
  });
  disposables.push(explicitAction);

  // command id 与追踪 Map 都只绑定当前编辑器。完整接受时命令桥仅传稳定 ID，
  // 不依赖 Monaco 保留对象引用；编辑器销毁后 Map 也会随 disposable 清空。
  provider.acceptCommandId = acceptCommandId;
  provider.trackedItems = trackedItems;

  return {
    disposables,
    triggerExplicit,
  };
}

function createMonacoInlineCompletionProvider(input: {
  monaco: MonacoApi;
  editor: editor.IStandaloneCodeEditor;
  client: CodeCompletionClient;
  getSnapshot: () => MonacoCompletionSnapshot;
  metrics: CodeCompletionMetricSink;
}): languages.InlineCompletionsProvider<TrackedInlineCompletions> & {
  acceptCommandId?: string;
  trackedItems?: Map<string, TrackedInlineCompletion>;
} {
  const provider: languages.InlineCompletionsProvider<TrackedInlineCompletions> & {
    acceptCommandId?: string;
    trackedItems?: Map<string, TrackedInlineCompletion>;
  } = {
    async provideInlineCompletions(
      model,
      position,
      context,
      token,
    ): Promise<TrackedInlineCompletions> {
      const snapshot = input.getSnapshot();
      const language = normalizeCompletionLanguage(model.getLanguageId());
      const trigger =
        context.triggerKind ===
        input.monaco.languages.InlineCompletionTriggerKind.Explicit
          ? "explicit"
          : "automatic";
      if (
        !snapshot.enabled ||
        (trigger === "automatic" && !snapshot.automaticEnabled) ||
        !language ||
        input.editor.getModel() !== model ||
        snapshot.path !== model.uri.path.replace(/^\/+/, "")
      ) {
        return { items: [] };
      }

      const modelVersion = model.getVersionId();
      const projectRevision = snapshot.projectRevision;
      const value = model.getValue();
      const offset = model.getOffsetAt(position);
      const abortController = new AbortController();
      const cancellation = token.onCancellationRequested(() => {
        abortController.abort("monaco_cancelled");
      });

      try {
        const result = await input.client.request({
          projectId: snapshot.projectId,
          projectRevision,
          path: snapshot.path,
          language,
          position: {
            lineNumber: position.lineNumber,
            column: position.column,
          },
          prefix: value.slice(0, offset),
          suffix: value.slice(offset),
          trigger,
          browserFiles:
            snapshot.storageKind === "browser_git"
              ? buildBrowserCompletionContext(
                  snapshot.browserFiles ?? [],
                  snapshot.path,
                  value,
                )
              : undefined,
          signal: abortController.signal,
        });

        const currentSnapshot = input.getSnapshot();
        if (
          !result ||
          token.isCancellationRequested ||
          !input.client.isCurrent(result.generation) ||
          !currentSnapshot.enabled ||
          currentSnapshot.path !== snapshot.path ||
          currentSnapshot.projectRevision !== projectRevision ||
          input.editor.getModel() !== model ||
          model.getVersionId() !== modelVersion ||
          result.response.projectRevision !== projectRevision ||
          !result.response.insertText
        ) {
          return { items: [] };
        }

        const trackingId = crypto.randomUUID();
        const item: TrackedInlineCompletion = {
          insertText: result.response.insertText,
          range: createInsertionRange(position),
          command: provider.acceptCommandId
            ? {
                id: provider.acceptCommandId,
                title: "Record accepted AI completion",
                arguments: [trackingId],
              }
            : undefined,
          tracking: {
            accepted: false,
            id: trackingId,
            partialAcceptedCharacters: 0,
            path: snapshot.path,
            projectId: snapshot.projectId,
            projectRevision,
            requestId: result.response.requestId,
            shown: false,
            trigger,
            model: result.response.model,
          },
        };

        provider.trackedItems?.set(trackingId, item);
        return {
          items: [item],
          enableForwardStability: true,
        };
      } catch {
        // 自动补全失败不应弹出全局错误或阻断用户输入。服务端错误仍带
        // correlation id 写入日志，下一次输入或显式触发可以自然重试。
        return { items: [] };
      } finally {
        cancellation.dispose();
      }
    },
    handleItemDidShow(_completions, item) {
      if (item.tracking.shown) {
        return;
      }
      item.tracking.shown = true;
      input.metrics(createLifecycleMetric(item, "shown"));
    },
    handlePartialAccept(_completions, item, acceptedCharacters) {
      item.tracking.partialAcceptedCharacters += acceptedCharacters;
      input.metrics({
        ...createLifecycleMetric(item, "partially_accepted"),
        value: item.tracking.partialAcceptedCharacters,
      });
    },
    freeInlineCompletions(completions) {
      for (const item of completions.items) {
        if (!item.tracking.shown) {
          continue;
        }

        // Monaco 在完整接受后也会释放列表。command 与 free 的调用顺序由
        // 编辑器内部决定，放到 microtask 再判断可避免把已接受误记为拒绝。
        queueMicrotask(() => {
          if (!item.tracking.accepted) {
            input.metrics(createLifecycleMetric(item, "rejected"));
          }
          provider.trackedItems?.delete(item.tracking.id);
        });
      }
    },
  };

  return provider;
}

function buildBrowserCompletionContext(
  files: readonly CodeCompletionSourceFile[],
  currentPath: string,
  currentValue: string,
): CodeCompletionSourceFile[] {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  byPath.set(currentPath, currentValue);
  const prioritizedPaths = [
    currentPath,
    "package.json",
    ...[...byPath.keys()].filter(
      (path) => path !== currentPath && path !== "package.json",
    ),
  ];
  const result: CodeCompletionSourceFile[] = [];
  let totalCharacters = 0;

  for (const path of prioritizedPaths) {
    const rawContent = byPath.get(path);
    if (
      rawContent === undefined ||
      result.length >= MAX_BROWSER_CONTEXT_FILES
    ) {
      continue;
    }

    const content = rawContent.slice(0, MAX_BROWSER_CONTEXT_FILE_CHARACTERS);
    const nextCharacters = path.length + content.length;
    if (totalCharacters + nextCharacters > MAX_BROWSER_CONTEXT_CHARACTERS) {
      continue;
    }

    result.push({ path, content });
    totalCharacters += nextCharacters;
  }

  return result;
}

function normalizeCompletionLanguage(
  language: string,
): CodeCompletionLanguage | null {
  return CODE_COMPLETION_LANGUAGES.includes(language as CodeCompletionLanguage)
    ? (language as CodeCompletionLanguage)
    : null;
}

function createInsertionRange(position: Position) {
  return {
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

function createLifecycleMetric(
  item: TrackedInlineCompletion,
  name: CodeCompletionMetric["name"],
): CodeCompletionMetric {
  return {
    name,
    projectId: item.tracking.projectId,
    path: item.tracking.path,
    projectRevision: item.tracking.projectRevision,
    requestId: item.tracking.requestId,
    trigger: item.tracking.trigger,
    model: item.tracking.model,
  };
}
