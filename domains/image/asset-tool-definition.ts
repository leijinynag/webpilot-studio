import type { LlmToolDefinition } from "@/domains/agent/provider";

export const LIST_PROJECT_ASSETS_TOOL_NAME = "list_project_assets";

export const LIST_PROJECT_ASSETS_TOOL_DEFINITION = {
  name: LIST_PROJECT_ASSETS_TOOL_NAME,
  description:
    "列出当前项目仍然有效的图片资产元数据，并返回可以在当前预览中使用的临时图片 URL。不会修改文件或公开私有 Blob 地址。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
} as const satisfies LlmToolDefinition;

export const PROJECT_ASSET_TOOL_DEFINITIONS = [
  LIST_PROJECT_ASSETS_TOOL_DEFINITION,
] as const;
