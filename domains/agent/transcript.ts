import type {
  AgentRunEvent,
  ProviderMessage,
  TranscriptMessage,
} from "@/domains/agent/types";
import { getTranscriptMessageKey } from "@/domains/agent/transcript-keys";

const DEFAULT_MAX_MESSAGE_CHARACTERS = 24_000;
const DEFAULT_MAX_CONTEXT_CHARACTERS = 96_000;

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
    maxContextCharacters?: number;
    attachmentContexts?: ReadonlyMap<string, string>;
  } = {},
): ProviderMessage[] {
  const maxCharacters =
    options.maxMessageCharacters ?? DEFAULT_MAX_MESSAGE_CHARACTERS;
  const contextCharacters =
    options.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS;
  const messages: ProviderMessage[] = [];
  const toolCallMessageIndexes = new Map<string, number>();
  const toolResultMessageIndexes = new Map<string, number>();

  if (options.systemPrompt) {
    messages.push({
      role: "system",
      content: boundText(options.systemPrompt, maxCharacters),
    });
  }

  for (const message of transcript) {
    switch (message.kind) {
      case "user_message":
        const attachmentContext = options.attachmentContexts?.get(
          getTranscriptMessageKey(message),
        );
        messages.push({
          role: "user",
          content: boundText(
            [
              message.content,
              ...(message.attachmentIds?.length
                ? [`[Attached image IDs: ${message.attachmentIds.join(", ")}]`]
                : []),
              ...(attachmentContext ? [attachmentContext] : []),
            ].join("\n\n"),
            maxCharacters,
          ),
        });
        break;
      case "assistant_message":
        messages.push({
          role: "assistant",
          content: boundText(message.content, maxCharacters),
        });
        break;
      case "tool_call":
        // Transcript 可能在 Provider 流中断或旧 Run 到达预算边界时停在
        // Tool Call 后面。先记录索引，等遍历完整段历史后再决定是否投影。
        // 这样不会改写数据库里的审计事实，只会过滤发给 Provider 的上下文。
        if (
          !message.toolCallId ||
          !message.toolName ||
          toolCallMessageIndexes.has(message.toolCallId)
        ) {
          break;
        }
        toolCallMessageIndexes.set(message.toolCallId, messages.length);
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
        if (
          !message.toolCallId ||
          !toolCallMessageIndexes.has(message.toolCallId) ||
          toolResultMessageIndexes.has(message.toolCallId)
        ) {
          break;
        }
        toolResultMessageIndexes.set(message.toolCallId, messages.length);
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

  const incompleteToolCallIndexes = new Set(
    [...toolCallMessageIndexes.entries()]
      .filter(([toolCallId]) => !toolResultMessageIndexes.has(toolCallId))
      .map(([, messageIndex]) => messageIndex),
  );
  const incompleteToolResultIndexes = new Set(
    [...toolResultMessageIndexes.entries()]
      .filter(([toolCallId]) => !toolCallMessageIndexes.has(toolCallId))
      .map(([, messageIndex]) => messageIndex),
  );

  const completeMessages = messages.filter((message, index) => {
    if (incompleteToolCallIndexes.has(index)) {
      return false;
    }
    if (incompleteToolResultIndexes.has(index)) {
      return false;
    }
    return true;
  });

  return trimProviderContext(completeMessages, contextCharacters);
}

/**
 * Provider 上下文按字符数设置硬上限，防止长会话在“继续”时把历史读写结果
 * 全量重新发送，最终因上下文超限而被供应商拒绝。工具调用和工具结果在
 * assemble 阶段已经保持相邻，因此裁剪时以这一对为最小单元，不留下孤立
 * tool 消息；最近的用户指令始终优先保留。
 */
function trimProviderContext(
  messages: readonly ProviderMessage[],
  maxCharacters: number,
): ProviderMessage[] {
  if (maxCharacters <= 0) {
    return [];
  }

  const systemMessages = messages.filter(
    (message) => message.role === "system",
  );
  const conversationalMessages = messages.filter(
    (message) => message.role !== "system",
  );
  const units: ProviderMessage[][] = [];
  for (const message of conversationalMessages) {
    const previous = units.at(-1);
    if (
      previous &&
      previous[0]?.role === "assistant" &&
      previous[0].toolCalls &&
      message.role === "tool" &&
      previous[0].toolCalls.some(
        (toolCall) => toolCall.id === message.toolCallId,
      )
    ) {
      previous.push(message);
    } else {
      units.push([message]);
    }
  }

  const selected: ProviderMessage[][] = [];
  let usedCharacters = systemMessages.reduce(
    (total, message) => total + providerMessageCharacters(message),
    0,
  );

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const unitCharacters = unit.reduce(
      (total, message) => total + providerMessageCharacters(message),
      0,
    );

    if (
      selected.length > 0 &&
      usedCharacters + unitCharacters > maxCharacters
    ) {
      break;
    }

    selected.unshift(unit);
    usedCharacters += unitCharacters;

    // 单条消息已经在上层按 maxMessageCharacters 截断，即使它本身超过总
    // 上下文预算，也要保留最近的用户指令或工具结果，不能把请求变成空上下文。
    if (usedCharacters >= maxCharacters) {
      break;
    }
  }

  return [...systemMessages, ...selected.flat()];
}

function providerMessageCharacters(message: ProviderMessage): number {
  return JSON.stringify(message).length;
}

/**
 * Assistant 的增量文本先以 Run Event 形式持久化，完整轮次结束后才追加
 * 到 Transcript。这个投影只负责恢复“尚未落库为完整消息”的临时文本，
 * 不会把流式中间态混入下一次模型上下文。
 */
export function projectPendingAssistantText(
  events: readonly AgentRunEvent[],
  activeRunId: string | null,
): string {
  if (!activeRunId) {
    return "";
  }

  let text = "";

  for (const event of events
    .filter((item) => item.runId === activeRunId)
    .toSorted((left, right) => left.sequence - right.sequence)) {
    if (
      event.type === "assistant.completed" ||
      event.type === "model.turn_retried"
    ) {
      text = "";
      continue;
    }

    if (event.type !== "assistant.delta") {
      continue;
    }

    const delta = event.payload.text;
    if (typeof delta === "string") {
      text += delta;
    }
  }

  return text;
}
