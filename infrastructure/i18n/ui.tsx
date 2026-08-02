"use client";

import { useRouter } from "next/navigation";
import { useCallback, useContext, useMemo } from "react";
import { createContext } from "react";

import type { Locale } from "@/infrastructure/i18n/locale";
import { LOCALE_COOKIE_NAME } from "@/infrastructure/i18n/locale";
import type { Messages } from "@/infrastructure/i18n/messages";
import { getMessages } from "@/infrastructure/i18n/messages";

type TranslationValue = string | number;
type TranslationValues = Record<string, TranslationValue>;

type UiI18nValue = {
  locale: Locale;
  messages: Messages;
  t: (key: string, values?: TranslationValues) => string;
  setLocale: (locale: Locale) => void;
};

const fallbackMessages = getMessages("zh");
const UiI18nContext = createContext<UiI18nValue | null>(null);

function readMessage(source: Messages, key: string): unknown {
  return key.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, source);
}

function interpolate(template: string, values?: TranslationValues): string {
  if (!values) {
    return template;
  }

  // 只实现消息字典当前需要的基础 ICU plural 形态，避免客户端适配层
  // 为了一个项目数量文案引入额外运行时。普通占位符仍按原规则处理。
  const pluralPattern =
    /\{(\w+),\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\}/g;
  const withPlural = template.replace(
    pluralPattern,
    (match, key: string, one: string, other: string) => {
      const count = Number(values[key]);
      if (!Number.isFinite(count)) {
        return match;
      }
      return count === 1 ? one : other;
    },
  );

  return withPlural.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * 单测和脱离 App Router 的局部渲染没有 Provider 时，返回稳定的兜底对象。
 * 如果在 hook 中每次创建新的 t 函数，使用它的 effect 会被误判为依赖变化，
 * 进而重复读取 Agent 快照或重建其他异步副作用。
 */
const fallbackUiI18nValue: UiI18nValue = {
  locale: "zh",
  messages: fallbackMessages,
  t: (key, values) =>
    interpolate(String(readMessage(fallbackMessages, key) ?? key), values),
  setLocale: () => undefined,
};

export function UiI18nProvider({
  children,
  locale,
  messages,
}: {
  children: React.ReactNode;
  locale: Locale;
  messages: Messages;
}) {
  const router = useRouter();
  const setLocale = useCallback(
    (nextLocale: Locale) => {
      document.cookie = [
        `${LOCALE_COOKIE_NAME}=${nextLocale}`,
        "Path=/",
        "Max-Age=31536000",
        "SameSite=Lax",
      ].join("; ");
      router.refresh();
    },
    [router],
  );
  const value = useMemo<UiI18nValue>(
    () => ({
      locale,
      messages,
      t: (key, values) => {
        const translated = readMessage(messages, key);
        const fallback = readMessage(fallbackMessages, key);
        const value = typeof translated === "string" ? translated : fallback;
        return interpolate(typeof value === "string" ? value : key, values);
      },
      setLocale,
    }),
    [locale, messages, setLocale],
  );

  return (
    <UiI18nContext.Provider value={value}>{children}</UiI18nContext.Provider>
  );
}

export function useUiI18n(): UiI18nValue {
  const context = useContext(UiI18nContext);
  if (context) {
    return context;
  }

  // 单测会直接渲染部分客户端组件，不一定经过 App Router Layout。
  // 中文兜底只用于这种脱离应用上下文的调用，真实页面始终使用 Provider。
  return fallbackUiI18nValue;
}
