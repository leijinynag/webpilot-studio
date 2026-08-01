/**
 * Monaco 0.52 的 package.json 没有为 editor.main.js 暴露 exports/types，
 * 但该 ESM 文件导出的正是公共 Monaco API，并额外注册内置语言贡献。
 * 这里把深层运行时入口映射回包根类型，避免复制一份容易漂移的声明。
 */
declare module "monaco-editor/esm/vs/editor/editor.main.js" {
  export * from "monaco-editor";
}
