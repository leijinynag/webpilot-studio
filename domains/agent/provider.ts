import type { ProviderMessage } from "@/domains/agent/types";

export type LlmToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ProviderTurnInput = {
  messages: readonly ProviderMessage[];
  tools: readonly LlmToolDefinition[];
  model: string;
  maxOutputTokens: number;
  userId?: string;
  signal?: AbortSignal;
};

export type ProviderFinishReason =
  "stop" | "length" | "tool_calls" | "content_filter" | "provider_interrupted";

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      toolCallId?: string;
      toolName?: string;
      argumentsDelta?: string;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | { type: "finish"; reason: ProviderFinishReason };

export interface LlmProvider {
  streamTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent>;
}
