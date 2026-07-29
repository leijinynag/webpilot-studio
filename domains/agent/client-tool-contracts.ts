import type { LlmToolDefinition } from "@/domains/agent/provider";
import { BROWSER_VERIFY_TOOL_NAME } from "@/domains/agent/client-tools";
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

const BROWSER_TARGET_JSON_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        strategy: { const: "test_id" },
        value: { type: "string" },
      },
      required: ["strategy", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        strategy: { const: "role_name" },
        role: { type: "string" },
        name: { type: "string" },
      },
      required: ["strategy", "role", "name"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        strategy: { const: "css" },
        selector: { type: "string" },
      },
      required: ["strategy", "selector"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        strategy: { const: "scan_id" },
        id: { type: "string" },
      },
      required: ["strategy", "id"],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * JSON Schema 只承担模型侧约束，真正的权限边界仍是 client-tools.ts 中的
 * strict Zod schema。这里完整列出动作，避免模型用自然语言步骤冒充可执行计划。
 */
export const BROWSER_VERIFY_TOOL_DEFINITION = {
  name: BROWSER_VERIFY_TOOL_NAME,
  description:
    "在当前 revision 上执行结构化浏览器冒烟步骤，并验证构建、运行时、Console、Network、Actions 与 Assertions。",
  parameters: {
    type: "object",
    properties: {
      revision: {
        type: "integer",
        description: "必须等于当前 Agent Run revision。",
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                action: { const: "click" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                timeoutMs: { type: "integer" },
              },
              required: ["action", "target"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "fill" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                value: { type: "string" },
                timeoutMs: { type: "integer" },
              },
              required: ["action", "target", "value"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "select" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                value: { type: "string" },
                timeoutMs: { type: "integer" },
              },
              required: ["action", "target", "value"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "press" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                key: { type: "string" },
                timeoutMs: { type: "integer" },
              },
              required: ["action", "key"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "wait_for" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                timeoutMs: { type: "integer" },
              },
              required: ["action", "timeoutMs"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "assert_text" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                text: { type: "string" },
                timeoutMs: { type: "integer" },
              },
              required: ["action", "text"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "assert_visible" },
                target: BROWSER_TARGET_JSON_SCHEMA,
                timeoutMs: { type: "integer" },
              },
              required: ["action", "target"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                action: { const: "assert_url" },
                pattern: { type: "string" },
                timeoutMs: { type: "integer" },
              },
              required: ["action", "pattern"],
              additionalProperties: false,
            },
          ],
        },
      },
      acceptedNetworkFailures: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            method: { type: "string" },
            origin: { type: "string" },
            path: { type: "string" },
            statuses: {
              type: "array",
              items: { type: "integer" },
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      observationMs: {
        type: "integer",
        description: "步骤完成后的运行时观察时间，范围 500 到 10000 毫秒。",
      },
    },
    required: ["revision", "steps"],
    additionalProperties: false,
  },
} as const satisfies LlmToolDefinition;
