// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { Position, editor, languages } from "monaco-editor";

import type {
  CodeCompletionClient,
  CodeCompletionClientResult,
  CodeCompletionMetric,
} from "@/infrastructure/code-completion/client";
import {
  registerMonacoCodeCompletion,
  type MonacoCompletionSnapshot,
} from "@/infrastructure/code-completion/monaco-provider";

const projectId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";

describe("Monaco code completion provider", () => {
  it("显式触发先恢复编辑器焦点，再执行 Monaco 行内建议命令", () => {
    const fixture = createFixture();

    fixture.registration.triggerExplicit();

    expect(fixture.focus).toHaveBeenCalledOnce();
    expect(fixture.trigger).toHaveBeenCalledWith(
      "webpilot.codeCompletion",
      "editor.action.inlineSuggest.trigger",
      null,
    );
    expect(fixture.focus.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.trigger.mock.invocationCallOrder[0]!,
    );
  });

  it("模型版本变化后丢弃返回结果，避免把旧补全插入新草稿", async () => {
    const deferred = createDeferred<CodeCompletionClientResult | null>();
    const fixture = createFixture({
      request: vi.fn(() => deferred.promise),
    });

    const pending = fixture.provider.provideInlineCompletions(
      fixture.model,
      fixture.position,
      fixture.automaticContext,
      fixture.token,
    );
    fixture.setModelVersion(2);
    deferred.resolve(createClientResult());

    await expect(pending).resolves.toEqual({ items: [] });
  });

  it("Repository revision 变化后丢弃返回结果", async () => {
    const deferred = createDeferred<CodeCompletionClientResult | null>();
    const fixture = createFixture({
      request: vi.fn(() => deferred.promise),
    });

    const pending = fixture.provider.provideInlineCompletions(
      fixture.model,
      fixture.position,
      fixture.automaticContext,
      fixture.token,
    );
    fixture.setSnapshot({ ...fixture.snapshot, projectRevision: 8 });
    deferred.resolve(createClientResult());

    await expect(pending).resolves.toEqual({ items: [] });
  });

  it("关闭自动补全只拦截自动请求，显式补全仍然可用", async () => {
    const fixture = createFixture();
    fixture.setSnapshot({
      ...fixture.snapshot,
      automaticEnabled: false,
    });

    await expect(
      fixture.provider.provideInlineCompletions(
        fixture.model,
        fixture.position,
        fixture.automaticContext,
        fixture.token,
      ),
    ).resolves.toEqual({ items: [] });
    expect(fixture.client.request).not.toHaveBeenCalled();

    const explicit = await fixture.provider.provideInlineCompletions(
      fixture.model,
      fixture.position,
      fixture.explicitContext,
      fixture.token,
    );
    expect(explicit?.items).toHaveLength(1);
    expect(fixture.client.request).toHaveBeenCalledOnce();
  });

  it("分别归因展示、接受和拒绝指标，接受项不会被重复记为拒绝", async () => {
    const fixture = createFixture();

    const acceptedCompletions = await fixture.provider.provideInlineCompletions(
      fixture.model,
      fixture.position,
      fixture.explicitContext,
      fixture.token,
    );
    if (!acceptedCompletions) {
      throw new Error("显式补全未返回建议集合。");
    }
    const acceptedItem = acceptedCompletions.items[0];
    expect(acceptedItem).toBeDefined();

    fixture.provider.handleItemDidShow?.(
      acceptedCompletions,
      acceptedItem,
      acceptedItem.insertText.toString(),
    );
    const acceptCommand = acceptedItem.command;
    expect(acceptCommand).toBeDefined();
    fixture.commandHandlers.get(acceptCommand!.id)?.(
      undefined,
      ...(acceptCommand!.arguments ?? []),
    );
    fixture.provider.freeInlineCompletions(acceptedCompletions);
    await Promise.resolve();

    const rejectedCompletions = await fixture.provider.provideInlineCompletions(
      fixture.model,
      fixture.position,
      fixture.automaticContext,
      fixture.token,
    );
    if (!rejectedCompletions) {
      throw new Error("自动补全未返回建议集合。");
    }
    const rejectedItem = rejectedCompletions.items[0];
    fixture.provider.handleItemDidShow?.(
      rejectedCompletions,
      rejectedItem,
      rejectedItem.insertText.toString(),
    );
    fixture.provider.freeInlineCompletions(rejectedCompletions);
    await Promise.resolve();

    expect(fixture.metrics.map((metric) => metric.name)).toEqual([
      "shown",
      "accepted",
      "shown",
      "rejected",
    ]);
    expect(fixture.metrics[0]).toMatchObject({
      projectId,
      projectRevision: 7,
      requestId,
      trigger: "explicit",
    });
    expect(
      fixture.metrics.filter((metric) => metric.name === "rejected"),
    ).toHaveLength(1);
  });
});

function createFixture(
  overrides: {
    request?: CodeCompletionClient["request"];
  } = {},
) {
  let modelVersion = 1;
  let snapshot: MonacoCompletionSnapshot = {
    automaticEnabled: true,
    enabled: true,
    projectId,
    projectRevision: 7,
    path: "src/App.tsx",
    storageKind: "database",
  };
  const metrics: CodeCompletionMetric[] = [];
  const providers: languages.InlineCompletionsProvider[] = [];
  const commandHandlers = new Map<
    string,
    (accessor: unknown, ...args: unknown[]) => void
  >();
  const model = {
    uri: { path: "/src/App.tsx" },
    getLanguageId: () => "typescript",
    getVersionId: () => modelVersion,
    getValue: () => "const answer = ",
    getOffsetAt: () => 15,
  } as unknown as editor.ITextModel;
  const focus = vi.fn();
  const trigger = vi.fn();
  const standaloneEditor = {
    getModel: () => model,
    addAction: () => ({ dispose: vi.fn() }),
    focus,
    trigger,
  } as unknown as editor.IStandaloneCodeEditor;
  const client: CodeCompletionClient = {
    request:
      overrides.request ??
      (vi.fn(async () =>
        createClientResult(),
      ) as CodeCompletionClient["request"]),
    isCurrent: vi.fn(() => true),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  const monaco = {
    KeyMod: {
      CtrlCmd: 1 << 11,
      Alt: 1 << 10,
    },
    KeyCode: { Space: 10 },
    languages: {
      InlineCompletionTriggerKind: {
        Automatic: 0,
        Explicit: 1,
      },
      registerInlineCompletionsProvider: (
        _language: string,
        provider: languages.InlineCompletionsProvider,
      ) => {
        providers.push(provider);
        return { dispose: vi.fn() };
      },
    },
    editor: {
      registerCommand: (
        id: string,
        handler: (accessor: unknown, ...args: unknown[]) => void,
      ) => {
        commandHandlers.set(id, handler);
        return { dispose: vi.fn() };
      },
    },
  } as unknown as Parameters<typeof registerMonacoCodeCompletion>[0]["monaco"];

  const registration = registerMonacoCodeCompletion({
    monaco,
    editor: standaloneEditor,
    client,
    getSnapshot: () => snapshot,
    metrics: (metric) => metrics.push(metric),
    actionLabel: "触发行内补全",
  });

  const provider = providers[0] as Required<
    Pick<
      languages.InlineCompletionsProvider,
      "provideInlineCompletions" | "handleItemDidShow" | "freeInlineCompletions"
    >
  >;
  // Provider 只读取行列号；测试桩无需实现 Monaco Position 的辅助方法，
  // 这里保留最小运行对象并在类型边界显式收窄。
  const position = {
    lineNumber: 1,
    column: 16,
  } as unknown as Position;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: vi.fn() }),
  };

  return {
    automaticContext: {
      triggerKind: 0,
      selectedSuggestionInfo: undefined,
    } satisfies languages.InlineCompletionContext,
    client,
    commandHandlers,
    explicitContext: {
      triggerKind: 1,
      selectedSuggestionInfo: undefined,
    } satisfies languages.InlineCompletionContext,
    metrics,
    model,
    position,
    provider,
    focus,
    registration,
    snapshot,
    token,
    trigger,
    setModelVersion(version: number) {
      modelVersion = version;
    },
    setSnapshot(nextSnapshot: MonacoCompletionSnapshot) {
      snapshot = nextSnapshot;
    },
  } as const;
}

function createClientResult(): CodeCompletionClientResult {
  return {
    generation: 1,
    response: {
      requestId,
      projectRevision: 7,
      insertText: "42",
      model: "deepseek-v4-flash",
      latencyMs: 25,
      firstResultLatencyMs: 18,
      cacheHit: false,
    },
  };
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred resolver 尚未初始化。");
  };
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
