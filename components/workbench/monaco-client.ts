"use client";

/**
 * WebContainer 要求页面启用 COEP: require-corp，而 @monaco-editor/react
 * 默认会从公共 CDN 下载 AMD 版本的 Monaco。跨域脚本没有携带允许嵌入的
 * 响应头时会被浏览器拒绝，编辑器便会永久停留在 Loading 状态。
 *
 * 这里把 Monaco 与各语言 Worker 都绑定到项目内安装的 npm 包。加载过程
 * 仍然是按需的，只有代码编辑器或 ChangeSet Diff 真正挂载时才进入客户端。
 */
type MonacoEnvironment = {
  getWorker: (moduleId: string, label: string) => Worker;
};

type MonacoGlobal = typeof globalThis & {
  MonacoEnvironment?: MonacoEnvironment;
};

let monacoReactPromise:
  Promise<typeof import("@monaco-editor/react")> | undefined;

export function loadLocalMonacoReact() {
  if (!monacoReactPromise) {
    monacoReactPromise = initializeLocalMonacoReact();
  }

  return monacoReactPromise;
}

async function initializeLocalMonacoReact() {
  configureMonacoWorkers();

  const [monacoReact, monaco] = await Promise.all([
    import("@monaco-editor/react"),
    // Monaco 0.52 只声明了 module 字段，没有标准 exports/main。Next 可以解析
    // 包根入口，但 Vitest 所用的 Vite 8 会把它视为无入口包；直接指向官方 ESM
    // 入口可让开发、测试和生产构建共享同一份本地 Monaco 实例。
    import("monaco-editor/esm/vs/editor/editor.main.js"),
  ]);

  // 向 React 包注入本地 ESM 实例后，它不会再创建指向公共 CDN 的 AMD
  // loader。显式等待初始化完成，也能让动态组件的 loading 状态准确反映
  // Monaco 是否已经可以创建 Editor 与 DiffEditor。
  monacoReact.loader.config({ monaco });
  await monacoReact.loader.init();

  return monacoReact;
}

function configureMonacoWorkers() {
  const monacoGlobal = globalThis as MonacoGlobal;

  if (monacoGlobal.MonacoEnvironment?.getWorker) {
    return;
  }

  monacoGlobal.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === "json") {
        return new Worker(
          new URL(
            "monaco-editor/esm/vs/language/json/json.worker.js",
            import.meta.url,
          ),
          { type: "module" },
        );
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(
          new URL(
            "monaco-editor/esm/vs/language/css/css.worker.js",
            import.meta.url,
          ),
          { type: "module" },
        );
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(
          new URL(
            "monaco-editor/esm/vs/language/html/html.worker.js",
            import.meta.url,
          ),
          { type: "module" },
        );
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(
          new URL(
            "monaco-editor/esm/vs/language/typescript/ts.worker.js",
            import.meta.url,
          ),
          { type: "module" },
        );
      }

      return new Worker(
        new URL(
          "monaco-editor/esm/vs/editor/editor.worker.js",
          import.meta.url,
        ),
        { type: "module" },
      );
    },
  };
}
