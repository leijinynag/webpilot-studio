import type { LlmToolDefinition } from "@/domains/agent/provider";
import {
  VISION_PROFILE,
} from "@/domains/image/vision";

export const INSPECT_ATTACHMENT_TOOL_NAME = "inspect_attachment";

export const INSPECT_ATTACHMENT_TOOL_DEFINITION = {
  name: INSPECT_ATTACHMENT_TOOL_NAME,
  description:
    "读取当前项目中的私有图片附件并返回结构化视觉摘要。不会把图片公开，也不会修改项目文件。",
  parameters: {
    type: "object",
    properties: {
      attachmentIds: {
        type: "array",
        minItems: 1,
        maxItems: VISION_PROFILE.maxAttachments,
        items: { type: "string", format: "uuid" },
        description: "当前项目中已上传图片附件的 ID。",
      },
      prompt: {
        type: "string",
        maxLength: VISION_PROFILE.maxPromptCharacters,
        description: "可选的聚焦问题，例如识别布局、文字或颜色。",
      },
    },
    required: ["attachmentIds"],
    additionalProperties: false,
  },
} as const satisfies LlmToolDefinition;

export const VISION_TOOL_DEFINITIONS = [
  INSPECT_ATTACHMENT_TOOL_DEFINITION,
] as const;

export {
  type InspectAttachmentArguments,
} from "@/domains/image/vision";
