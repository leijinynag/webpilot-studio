import { DeepSeekProvider } from "@/infrastructure/agent/deepseek-provider";

/**
 * 复用 OpenAI-compatible SSE、工具调用和超时处理。
 * 这里只关闭 DeepSeek 专属的 thinking 参数，避免把供应商私有字段
 * 发送给 gpt-5.5 等兼容模型。
 */
export class OpenAiCompatibleAgentProvider extends DeepSeekProvider {
  constructor(options: ConstructorParameters<typeof DeepSeekProvider>[0]) {
    super({
      ...options,
      includeThinking: false,
    });
  }
}
