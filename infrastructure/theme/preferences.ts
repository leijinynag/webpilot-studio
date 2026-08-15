export const THEME_STORAGE_KEY = "webpilot-theme-v1";
export const THEME_COOKIE_NAME = "webpilot-theme";

export type ThemePreference = "system" | "light" | "dark";

/**
 * Cookie、localStorage 和 UI 事件都经过同一解析入口。
 * 外部值不可信，无法识别时统一回退到 system，避免把任意字符串写入 DOM 属性。
 */
export function resolveThemePreference(
  value: string | null | undefined,
): ThemePreference {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}
