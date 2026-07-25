import type { FileSystemTree } from "@webcontainer/api";

// 端口同时被 Rsbuild 配置、server-ready 过滤和 UI 占位信息使用。
// 固定为单一常量可以避免服务已启动但 Manager 因端口不一致而一直等待。
export const WEBPILOT_PREVIEW_PORT = 5173;

// M0 模板使用精确版本而不是范围版本，确保浏览器内每次安装得到相同的工具链，
// 避免上游小版本发布导致演示环境和自动化测试无预警漂移。
const packageJson = {
  name: "webpilot-preview-project",
  version: "0.1.0",
  private: true,
  // Rsbuild 配置以 ESM 方式加载；显式声明可避免 WebContainer 内 Node 的模块推断差异。
  type: "module",
  scripts: {
    // WebContainer 不提供宿主机原生 ABI，因此显式使用 Rspack 的 WASI 绑定。
    dev: "RSPACK_BINDING=@rspack/binding-wasm32-wasi rsbuild dev",
    build: "RSPACK_BINDING=@rspack/binding-wasm32-wasi rsbuild build",
  },
  dependencies: {
    "@rsbuild/core": "2.1.8",
    "@rsbuild/plugin-react": "2.1.0",
    "@rspack/binding-wasm32-wasi": "2.1.5",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    react: "19.2.4",
    "react-dom": "19.2.4",
    typescript: "5.9.3",
  },
};

/**
 * M0 使用固定版本的最小项目，先验证浏览器 Node.js、包安装和 dev server
 * 三件事可以形成闭环。后续 Repository 层接入后，这棵树会被项目快照替代。
 *
 * FileSystemTree 是 WebContainer mount 的原生结构。模板保持纯内存数据，
 * 不依赖宿主仓库文件系统，因此未来也可以由远端项目快照或 Agent 产物直接生成。
 */
export const WEBPILOT_RSBUILD_TEMPLATE: FileSystemTree = {
  "package.json": {
    file: {
      contents: `${JSON.stringify(packageJson, null, 2)}\n`,
    },
  },
  "index.html": {
    file: {
      contents: `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0b0d10" />
    <title>WebPilot Preview</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
    },
  },
  "rsbuild.config.ts": {
    file: {
      // host=0.0.0.0 允许 WebContainer 的代理层访问 dev server；
      // strictPort 禁止自动换端口，否则 Manager 监听的固定端口契约会失效。
      contents: `import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  server: {
    host: "0.0.0.0",
    port: ${WEBPILOT_PREVIEW_PORT},
    strictPort: true,
  },
});
`,
    },
  },
  "tsconfig.json": {
    file: {
      contents: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            useDefineForClassFields: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            allowJs: false,
            skipLibCheck: true,
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            strict: true,
            forceConsistentCasingInFileNames: true,
            module: "ESNext",
            moduleResolution: "Bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: "react-jsx",
          },
          include: ["src", "rsbuild.config.ts"],
        },
        null,
        2,
      )}\n`,
    },
  },
  src: {
    directory: {
      // Rsbuild 2 的默认 React 入口是 src/index.tsx，名称必须与框架约定一致。
      "index.tsx": {
        file: {
          contents: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

function App() {
  return (
    <main className="runtime-page">
      <section className="runtime-hero">
        <span className="runtime-kicker">WEBPILOT RUNTIME / 0.3</span>
        <p className="runtime-status">
          <span aria-hidden="true" />
          Rsbuild dev server connected
        </p>
        <h1>The browser is now the development machine.</h1>
        <p className="runtime-copy">
          这个 React 页面由 WebContainer 在当前标签页中安装依赖、编译并运行。
          下一步，Repository 会成为代码事实来源，Agent 的修改将实时同步到这里。
        </p>
        <div className="runtime-grid">
          <article>
            <b>01</b>
            <span>Project mounted</span>
          </article>
          <article>
            <b>02</b>
            <span>Dependencies installed</span>
          </article>
          <article>
            <b>03</b>
            <span>Preview served</span>
          </article>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
        },
      },
      "styles.css": {
        file: {
          contents: `* {
  box-sizing: border-box;
}

:root {
  color: #eceeea;
  background: #090b0d;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

body {
  margin: 0;
}

.runtime-page {
  display: grid;
  min-height: 100vh;
  padding: clamp(24px, 7vw, 84px);
  place-items: center;
  background:
    linear-gradient(rgb(255 255 255 / 4%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 4%) 1px, transparent 1px),
    #090b0d;
  background-size: 36px 36px;
}

.runtime-hero {
  width: min(100%, 920px);
}

.runtime-kicker {
  color: #d99873;
  font-size: 12px;
  font-weight: 800;
}

.runtime-status {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 24px 0 10px;
  color: #9ca4aa;
  font-size: 13px;
}

.runtime-status span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9bb9c6;
  box-shadow: 0 0 0 5px rgb(155 185 198 / 12%);
}

h1 {
  max-width: 780px;
  margin: 0;
  font-family: Georgia, serif;
  font-size: clamp(44px, 8vw, 88px);
  font-weight: 400;
  line-height: 0.98;
}

.runtime-copy {
  max-width: 680px;
  margin: 28px 0 42px;
  color: #a7aaad;
  font-size: 16px;
  line-height: 1.75;
}

.runtime-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border-top: 1px solid rgb(255 255 255 / 13%);
}

.runtime-grid article {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 18px 20px 0;
}

.runtime-grid b {
  color: #d99873;
  font-family: ui-monospace, monospace;
  font-size: 11px;
}

.runtime-grid span {
  font-size: 13px;
}

@media (max-width: 640px) {
  .runtime-grid {
    grid-template-columns: 1fr;
  }
}
`,
        },
      },
    },
  },
};
