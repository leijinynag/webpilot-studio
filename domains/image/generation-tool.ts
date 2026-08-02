import type { LlmToolDefinition } from "@/domains/agent/provider";
import {
  generateImageArgumentsSchema,
  IMAGE_GENERATION_PROFILE,
} from "@/domains/image/generation";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export const GENERATE_IMAGE_TOOL_DEFINITION = {
  name: GENERATE_IMAGE_TOOL_NAME,
  description:
    "根据文字描述异步生成图片并保存到当前项目资产库。任务完成后会自动恢复 Agent；每次最多生成 4 张图片。",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: IMAGE_GENERATION_PROFILE.maxPromptCharacters,
        description: "要生成的图片内容和风格描述。",
      },
      count: {
        type: "integer",
        minimum: 1,
        maximum: IMAGE_GENERATION_PROFILE.maxImages,
        default: 1,
        description: "生成图片数量，默认 1 张。",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1024x1536", "1536x1024"],
        default: IMAGE_GENERATION_PROFILE.defaultSize,
        description: "图片尺寸。",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const satisfies LlmToolDefinition;

export const IMAGE_GENERATION_TOOL_DEFINITIONS = [
  GENERATE_IMAGE_TOOL_DEFINITION,
] as const;

export { generateImageArgumentsSchema };
