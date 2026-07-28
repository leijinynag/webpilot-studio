import type { LlmToolDefinition } from "@/domains/agent/provider";
import { RUN_PREVIEW_TOOL_NAME } from "@/domains/agent/evidence";

/**
 * JSON Schema 提供给模型，Zod schema 则负责运行时严格校验。
 * 两者都禁止额外字段，避免模型把自然语言说明混入工具参数。
 */
export const RUN_PREVIEW_TOOL_DEFINITION = {
  name: RUN_PREVIEW_TOOL_NAME,
  description:
    "在浏览器 WebContainer 中运行指定 revision，收集安装、开发服务器、页面运行时与 console warn/error 证据。",
  parameters: {
    type: "object",
    properties: {
      revision: {
        type: "integer",
        description: "需要验证的当前 Repository revision。",
      },
      observationMs: {
        type: "integer",
        description: "页面首帧后的观察时间，范围 500 到 10000 毫秒。",
      },
    },
    required: ["revision"],
    additionalProperties: false,
  },
} as const satisfies LlmToolDefinition;
