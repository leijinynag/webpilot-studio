import type { Locale } from "@/infrastructure/i18n/locale";

import en from "@/messages/en.json";
import zh from "@/messages/zh.json";

export const messages = { zh, en } as const;
export type Messages = (typeof messages)[Locale];

export function getMessages(locale: Locale): Messages {
  return messages[locale];
}

type MessageTree = Record<string, unknown>;

export function flattenMessageKeys(
  value: MessageTree,
  prefix = "",
): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === "object" && !Array.isArray(child)
      ? flattenMessageKeys(child as MessageTree, next)
      : [next];
  });
}
