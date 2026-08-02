export const SUPPORTED_LOCALES = ["zh", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh";
export const LOCALE_COOKIE_NAME = "NEXT_LOCALE";

/**
 * Agent Run 使用更完整的 BCP 47 locale，而 UI 和 Cookie 只保留稳定的
 * 产品语言枚举。这样翻译切换不会把 zh-CN、zh-Hans 等变体写进协议。
 */
export function toAgentLocale(locale: Locale): "zh-CN" | "en-US" {
  return locale === "en" ? "en-US" : "zh-CN";
}

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  if (
    normalized === "zh" ||
    normalized.startsWith("zh-") ||
    normalized.includes("hans")
  ) {
    return "zh";
  }
  return null;
}

/**
 * 解析 Accept-Language 的第一条受支持语言。未知语言不参与排序，
 * 避免浏览器的日文、法文偏好意外覆盖产品默认中文。
 */
export function resolveAcceptLanguage(value: string | null): Locale | null {
  if (!value) {
    return null;
  }

  for (const item of value.split(",")) {
    const [language, ...parameters] = item.trim().split(";");
    const quality = parameters.find((parameter) =>
      parameter.trim().startsWith("q="),
    );
    if (quality && Number(quality.trim().slice(2)) === 0) {
      continue;
    }
    const locale = normalizeLocale(language);
    if (locale) {
      return locale;
    }
  }

  return null;
}

export function resolveLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  return (
    normalizeLocale(input.cookie) ??
    resolveAcceptLanguage(input.acceptLanguage ?? null) ??
    DEFAULT_LOCALE
  );
}

export function localeToHtmlLang(locale: Locale): "zh-CN" | "en-US" {
  return locale === "en" ? "en-US" : "zh-CN";
}
