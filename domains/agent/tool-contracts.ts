import type { LlmToolDefinition } from "@/domains/agent/provider";

export const FILE_TOOL_NAMES = {
  listFiles: "list_files",
  searchText: "search_text",
  readFile: "read_file",
  writeFile: "write_file",
  deleteFile: "delete_file",
  renameFile: "rename_file",
} as const;

export type FileToolName =
  (typeof FILE_TOOL_NAMES)[keyof typeof FILE_TOOL_NAMES];

const PROJECT_PATH_SCHEMA = {
  type: "string",
  description: "项目内相对路径，例如 src/App.tsx。",
} as const;

/**
 * Provider、服务端工具执行器与未来浏览器工具都引用同一组名称和 JSON Schema。
 * additionalProperties=false 与运行时 Zod strict 校验形成双层约束。
 */
export const FILE_TOOL_DEFINITIONS = [
  {
    name: FILE_TOOL_NAMES.listFiles,
    description: "列出项目当前 revision 下的全部文件。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: FILE_TOOL_NAMES.searchText,
    description: "在项目文本文件中搜索精确字符串。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的非空文本。" },
        maxResults: {
          type: "integer",
          description: "最多返回的匹配数量，范围 1 到 100。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: FILE_TOOL_NAMES.readFile,
    description: "读取一个项目文件；修改已有文件前必须先读取。",
    parameters: {
      type: "object",
      properties: { path: PROJECT_PATH_SCHEMA },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: FILE_TOOL_NAMES.writeFile,
    description: "创建或覆盖一个项目文件，必须携带预期 revision。",
    parameters: {
      type: "object",
      properties: {
        path: PROJECT_PATH_SCHEMA,
        content: { type: "string", description: "文件完整内容。" },
        expectedRevision: {
          type: "integer",
          description: "执行 mutation 前观察到的项目 revision。",
        },
      },
      required: ["path", "content", "expectedRevision"],
      additionalProperties: false,
    },
  },
  {
    name: FILE_TOOL_NAMES.deleteFile,
    description: "删除一个已读取的项目文件，必须携带预期 revision。",
    parameters: {
      type: "object",
      properties: {
        path: PROJECT_PATH_SCHEMA,
        expectedRevision: {
          type: "integer",
          description: "执行 mutation 前观察到的项目 revision。",
        },
      },
      required: ["path", "expectedRevision"],
      additionalProperties: false,
    },
  },
  {
    name: FILE_TOOL_NAMES.renameFile,
    description: "重命名一个已读取的项目文件，必须携带预期 revision。",
    parameters: {
      type: "object",
      properties: {
        fromPath: PROJECT_PATH_SCHEMA,
        toPath: PROJECT_PATH_SCHEMA,
        expectedRevision: {
          type: "integer",
          description: "执行 mutation 前观察到的项目 revision。",
        },
      },
      required: ["fromPath", "toPath", "expectedRevision"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly LlmToolDefinition[];
