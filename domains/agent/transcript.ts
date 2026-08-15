import type {
  AgentRunEvent,
  ContextCheckpoint,
  ProviderMessage,
  TranscriptMessage,
} from "@/domains/agent/types";
import { getTranscriptMessageKey } from "@/domains/agent/transcript-keys";

const DEFAULT_MAX_MESSAGE_CHARACTERS = 24_000;
const DEFAULT_MAX_CONTEXT_CHARACTERS = 96_000;

type ProjectedProviderMessage = {
  message: ProviderMessage;
  /**
   * protected 只存在于本次 Provider 投影，不进入 Transcript。当前 Run 和
   * system 上下文即使突破兜底字符预算也必须保留，避免“继续”丢失现场。
   */
  protected: boolean;
};

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
    contextCheckpoint?: ContextCheckpoint;
    protectedRunId?: string;
  } = {},
): ProviderMessage[] {
  const maxCharacters =
    options.maxMessageCharacters ?? DEFAULT_MAX_MESSAGE_CHARACTERS;
  const contextCharacters =
    options.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS;
  const messages: ProjectedProviderMessage[] = [];
  const toolCallMessageIndexes = new Map<string, number>();
  const toolResultMessageIndexes = new Map<string, number>();

  if (options.systemPrompt) {
    messages.push({
      message: {
        role: "system",
        content: boundText(options.systemPrompt, maxCharacters),
      },
      protected: true,
    });
  }

  const checkpoint = options.contextCheckpoint;
  if (checkpoint?.summary) {
    messages.push({
      message: {
        role: "system",
        content: boundText(
          `以下是较早对话的 ContextCheckpoint 摘要。它只用于恢复上下文，若与后续完整消息冲突，以后续消息为准：\n\n${checkpoint.summary}`,
          maxCharacters,
        ),
      },
      protected: true,
    });
  }

  const projectedTranscript = checkpoint?.summary
    ? transcript.filter(
        (item) =>
          item.seq === undefined ||
          item.seq > checkpoint.transcriptSeq ||
          item.runId === options.protectedRunId,
      )
    : transcript;

  for (const message of projectedTranscript) {
    const protectedMessage =
      options.protectedRunId !== undefined &&
      message.runId === options.protectedRunId;
    switch (message.kind) {
      case "user_message":
        const attachmentContext = options.attachmentContexts?.get(
          getTranscriptMessageKey(message),
        );
        messages.push({
          message: {
            role: "user",
            content: boundText(
              [
                message.content,
                ...(message.attachmentIds?.length
                  ? [
                      `[Attached image IDs: ${message.attachmentIds.join(", ")}]`,
                    ]
                  : []),
                ...(attachmentContext ? [attachmentContext] : []),
              ].join("\n\n"),
              maxCharacters,
            ),
          },
          protected: protectedMessage,
        });
        break;
      case "assistant_message":
        messages.push({
          message: {
            role: "assistant",
            content: boundText(message.content, maxCharacters),
          },
          protected: protectedMessage,
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
          message: {
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
          },
          protected: protectedMessage,
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
          message: {
            role: "tool",
            toolCallId: message.toolCallId,
            content: boundText(
              JSON.stringify(message.resultJson),
              maxCharacters,
            ),
          },
          protected: protectedMessage,
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
 * 全量重新发送，最终因上下文超限而被供应商拒绝。同一模型轮次可能先连续
 * 返回多个 Tool Call，再连续返回对应结果，调用和结果不一定相邻。因此这里
 * 先按 toolCallId 建立配对区间，再合并相互重叠的区间；裁剪只能整段保留或
 * 整段丢弃，既不改变原始顺序，也不会留下孤立的 tool 消息。
 */
function trimProviderContext(
  messages: readonly ProjectedProviderMessage[],
  maxCharacters: number,
): ProviderMessage[] {
  if (maxCharacters <= 0) {
    return [];
  }

  const systemMessages = messages.filter(
    ({ message }) => message.role === "system",
  );
  const conversationalMessages = messages.filter(
    ({ message }) => message.role !== "system",
  );
  const units = buildProviderContextUnits(conversationalMessages);

  const selectedUnitIndexes = new Set<number>();
  let usedCharacters = systemMessages.reduce(
    (total, item) => total + providerMessageCharacters(item.message),
    0,
  );

  // 第一阶段先锁定所有受保护单元。当前 Run 的消息可能被其他 Run 的大段
  // 输出隔开，不能在从尾部裁剪时遇到超预算普通单元就提前停止。工具调用单元
  // 只要有任意一条属于当前 Run，整个 call/result 区间都会一起进入保护集。
  units.forEach((unit, index) => {
    if (!unit.some((item) => item.protected)) {
      return;
    }
    selectedUnitIndexes.add(index);
    usedCharacters += unit.reduce(
      (total, item) => total + providerMessageCharacters(item.message),
      0,
    );
  });

  let selectedOrdinaryUnits = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (selectedUnitIndexes.has(index)) {
      continue;
    }
    const unitCharacters = unit.reduce(
      (total, item) => total + providerMessageCharacters(item.message),
      0,
    );

    if (usedCharacters + unitCharacters > maxCharacters) {
      // 没有任何受保护现场时，至少保留最新的一个完整单元。单条超长消息或
      // 一组完整工具调用可以突破字符预算，但不会因此把更旧历史继续带进来。
      if (selectedUnitIndexes.size === 0 && selectedOrdinaryUnits === 0) {
        selectedUnitIndexes.add(index);
      }
      break;
    }

    selectedUnitIndexes.add(index);
    selectedOrdinaryUnits += 1;
    usedCharacters += unitCharacters;
  }

  return [
    ...systemMessages,
    ...units.flatMap((unit, index) =>
      selectedUnitIndexes.has(index) ? unit : [],
    ),
  ].map((item) => item.message);
}

/**
 * 把 Provider 消息切成可安全裁剪的连续单元。
 *
 * 例如 `call-1, call-2, result-1, result-2` 会产生两个交叉区间
 * `[0, 2]` 与 `[1, 3]`，最终合并为一个 `[0, 3]` 单元。区间之间的普通
 * assistant/user 消息也会随所在区间一起保留，避免为了重新排序工具消息而
 * 改写真实对话顺序。
 */
function buildProviderContextUnits(
  messages: readonly ProjectedProviderMessage[],
): ProjectedProviderMessage[][] {
  const callIndexes = new Map<string, number>();
  const resultIndexes = new Map<string, number>();

  messages.forEach(({ message }, index) => {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        if (!callIndexes.has(toolCall.id)) {
          callIndexes.set(toolCall.id, index);
        }
      }
      return;
    }

    if (
      message.role === "tool" &&
      message.toolCallId &&
      !resultIndexes.has(message.toolCallId)
    ) {
      resultIndexes.set(message.toolCallId, index);
    }
  });

  const pairedIntervals = [...callIndexes.entries()]
    .flatMap(([toolCallId, callIndex]) => {
      const resultIndex = resultIndexes.get(toolCallId);
      return resultIndex === undefined
        ? []
        : [
            {
              start: Math.min(callIndex, resultIndex),
              end: Math.max(callIndex, resultIndex),
            },
          ];
    })
    .toSorted(
      (left, right) => left.start - right.start || left.end - right.end,
    );

  const mergedIntervals: Array<{ start: number; end: number }> = [];
  for (const interval of pairedIntervals) {
    const previous = mergedIntervals.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      mergedIntervals.push({ ...interval });
    }
  }

  const units: ProjectedProviderMessage[][] = [];
  let messageIndex = 0;
  let intervalIndex = 0;
  while (messageIndex < messages.length) {
    const interval = mergedIntervals[intervalIndex];
    if (interval && messageIndex === interval.start) {
      units.push(messages.slice(interval.start, interval.end + 1));
      messageIndex = interval.end + 1;
      intervalIndex += 1;
      continue;
    }

    units.push([messages[messageIndex]]);
    messageIndex += 1;
  }

  return units;
}

export function providerMessageCharacters(message: ProviderMessage): number {
  return JSON.stringify(message).length;
}

export function estimateProviderContextCharacters(
  messages: readonly ProviderMessage[],
): number {
  return messages.reduce(
    (total, message) => total + providerMessageCharacters(message),
    0,
  );
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
