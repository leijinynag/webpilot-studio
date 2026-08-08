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

type MonacoDiagnosticsDefaults = {
  setDiagnosticsOptions: (options: {
    noSemanticValidation: boolean;
    noSuggestionDiagnostics: boolean;
    noSyntaxValidation: boolean;
  }) => void;
};

type MonacoDiagnosticsApi = {
  languages: {
    typescript: {
      javascriptDefaults: MonacoDiagnosticsDefaults;
      typescriptDefaults: MonacoDiagnosticsDefaults;
    };
  };
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

  configureMonacoDiagnostics(monaco);

  // 向 React 包注入本地 ESM 实例后，它不会再创建指向公共 CDN 的 AMD
  // loader。显式等待初始化完成，也能让动态组件的 loading 状态准确反映
  // Monaco 是否已经可以创建 Editor 与 DiffEditor。
  monacoReact.loader.config({ monaco });
  await monacoReact.loader.init();

  return monacoReact;
}

/**
 * 工作台当前没有把 WebContainer 的 node_modules、tsconfig 与全部声明文件同步
 * 到 Monaco TypeScript Worker。此时语义诊断会把“找不到 react / node 类型”等
 * 环境缺口标红，用户很容易把它误认为代码已经无法运行。
 *
 * 这里保留语法诊断，用于提示括号、字符串、关键字等确定性错误；语义与建议型
 * 诊断暂时交给保存后的项目 TypeScript、Preview 构建和 Agent 验证链。后续接入
 * 项目级 TypeScript Language Service 后，可以在完整类型图上重新启用语义检查。
 */
export function configureMonacoDiagnostics(monaco: MonacoDiagnosticsApi) {
  const options = {
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
    noSyntaxValidation: false,
  };

  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(options);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(options);
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
