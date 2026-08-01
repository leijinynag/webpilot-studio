import type { LlmToolDefinition } from "@/domains/agent/provider";
import { z } from "zod";

import { assertValidProjectPath } from "@/domains/project/path";

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

export const GIT_TOOL_NAMES = {
  status: "git_status",
  log: "git_log",
  currentBranch: "git_current_branch",
  stage: "git_stage",
  unstage: "git_unstage",
  commit: "git_commit",
} as const;

export type GitToolName = (typeof GIT_TOOL_NAMES)[keyof typeof GIT_TOOL_NAMES];

const projectPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform(assertValidProjectPath);
const expectedRevisionSchema = z.number().int().nonnegative();

export const FILE_TOOL_SCHEMAS = {
  [FILE_TOOL_NAMES.listFiles]: z.object({}).strict(),
  [FILE_TOOL_NAMES.searchText]: z
    .object({
      query: z.string().trim().min(1).max(200),
      maxResults: z.number().int().positive().max(100).optional(),
    })
    .strict(),
  [FILE_TOOL_NAMES.readFile]: z.object({ path: projectPathSchema }).strict(),
  [FILE_TOOL_NAMES.writeFile]: z
    .object({
      path: projectPathSchema,
      content: z.string().max(1_000_000),
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
  [FILE_TOOL_NAMES.deleteFile]: z
    .object({
      path: projectPathSchema,
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
  [FILE_TOOL_NAMES.renameFile]: z
    .object({
      fromPath: projectPathSchema,
      toPath: projectPathSchema,
      expectedRevision: expectedRevisionSchema,
    })
    .strict(),
} as const;

export const GIT_TOOL_SCHEMAS = {
  [GIT_TOOL_NAMES.status]: z.object({}).strict(),
  [GIT_TOOL_NAMES.log]: z
    .object({
      maxCount: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  [GIT_TOOL_NAMES.currentBranch]: z.object({}).strict(),
  [GIT_TOOL_NAMES.stage]: z
    .object({
      paths: z.array(projectPathSchema).min(1).max(200),
    })
    .strict(),
  [GIT_TOOL_NAMES.unstage]: z
    .object({
      paths: z.array(projectPathSchema).min(1).max(200),
    })
    .strict(),
  [GIT_TOOL_NAMES.commit]: z
    .object({
      message: z.string().trim().min(1).max(500),
    })
    .strict(),
} as const;

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

export const GIT_TOOL_DEFINITIONS = [
  {
    name: GIT_TOOL_NAMES.status,
    description:
      "读取 Browser Git 当前 staged、unstaged、untracked 状态。只读操作。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: GIT_TOOL_NAMES.log,
    description: "读取 Browser Git 本地提交历史。只读操作。",
    parameters: {
      type: "object",
      properties: {
        maxCount: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "最多返回的提交数量。",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: GIT_TOOL_NAMES.currentBranch,
    description: "读取 Browser Git 当前本地分支。只读操作。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: GIT_TOOL_NAMES.stage,
    description:
      "把指定路径加入 Browser Git 暂存区。只有原始用户消息明确授权 stage 时才允许。",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: PROJECT_PATH_SCHEMA,
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: GIT_TOOL_NAMES.unstage,
    description:
      "把指定路径移出 Browser Git 暂存区。只有原始用户消息明确授权 unstage 时才允许。",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: PROJECT_PATH_SCHEMA,
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: GIT_TOOL_NAMES.commit,
    description:
      "提交 Browser Git 已暂存内容。必须有原始用户明确 commit 指令和冻结的作者姓名、邮箱。",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "本地 Git commit message。",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly LlmToolDefinition[];
