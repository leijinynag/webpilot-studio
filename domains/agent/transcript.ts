import type { ProviderMessage, TranscriptMessage } from "@/domains/agent/types";

const DEFAULT_MAX_MESSAGE_CHARACTERS = 24_000;

function boundText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }

  return `${value.slice(0, maxCharacters)}\n[内容已截断]`;
}

/**
 * Transcript 是产品事实，ProviderMessage 只是某次模型调用的投影。
 * System Event 用于 UI/审计，不直接暴露给模型，防止传输状态污染推理上下文。
 */
export function assembleProviderMessages(
  transcript: readonly TranscriptMessage[],
  options: {
    systemPrompt?: string;
    maxMessageCharacters?: number;
  } = {},
): ProviderMessage[] {
  const maxCharacters =
    options.maxMessageCharacters ?? DEFAULT_MAX_MESSAGE_CHARACTERS;
  const messages: ProviderMessage[] = [];

  if (options.systemPrompt) {
    messages.push({
      role: "system",
      content: boundText(options.systemPrompt, maxCharacters),
    });
  }

  for (const message of transcript) {
    switch (message.kind) {
      case "user_message":
        messages.push({
          role: "user",
          content: boundText(message.content, maxCharacters),
        });
        break;
      case "assistant_message":
        messages.push({
          role: "assistant",
          content: boundText(message.content, maxCharacters),
        });
        break;
      case "tool_call":
        messages.push({
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: message.toolCallId,
              name: message.toolName,
              argumentsJson: boundText(
                JSON.stringify(message.argumentsJson),
                maxCharacters,
              ),
            },
          ],
        });
        break;
      case "tool_result":
        messages.push({
          role: "tool",
          toolCallId: message.toolCallId,
          content: boundText(JSON.stringify(message.resultJson), maxCharacters),
        });
        break;
      case "system_event":
        break;
    }
  }

  return messages;
}
