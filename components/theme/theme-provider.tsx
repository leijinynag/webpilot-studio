"use client";

import * as React from "react";

import {
  THEME_COOKIE_NAME,
  THEME_STORAGE_KEY,
  resolveThemePreference,
  type ThemePreference,
} from "@/infrastructure/theme/preferences";

export type { ThemePreference } from "@/infrastructure/theme/preferences";

let currentPreference: ThemePreference = "system";
const themeListeners = new Set<() => void>();

if (typeof window !== "undefined") {
  currentPreference = resolveThemePreference(
    window.localStorage.getItem(THEME_STORAGE_KEY),
  );
}

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(preference: ThemePreference) {
  const resolvedTheme = preference === "system" ? getSystemTheme() : preference;
  const root = document.documentElement;

  // 主题属性同时服务 CSS 和原生控件，避免 select、滚动条等浏览器元素掉出主题。
  root.dataset.theme = resolvedTheme;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.style.colorScheme = resolvedTheme;
}

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function getThemePreference() {
  return currentPreference;
}

export function ThemeProvider({
  children,
  initialPreference,
}: {
  children: React.ReactNode;
  initialPreference: ThemePreference;
}) {
  const preference = React.useSyncExternalStore(
    subscribeToTheme,
    getThemePreference,
    () => initialPreference,
  );

  React.useEffect(() => {
    // 兼容旧版本只写 localStorage 的用户，并保证后续 SSR 能直接输出明确主题。
    persistThemePreference(preference);

    // system 模式需要监听系统偏好变化，用户主动选择明暗主题时则不订阅。
    if (preference !== "system") {
      applyTheme(preference);
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyTheme("system");

    applyTheme("system");
    mediaQuery.addEventListener("change", handleSystemThemeChange);

    return () =>
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [preference]);

  const setPreference = React.useCallback((nextPreference: ThemePreference) => {
    persistThemePreference(nextPreference);
    currentPreference = nextPreference;
    applyTheme(nextPreference);
    themeListeners.forEach((listener) => listener());
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = React.useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme 必须在 ThemeProvider 内部使用");
  }

  return context;
}

function persistThemePreference(preference: ThemePreference) {
  // localStorage 负责同标签页即时恢复，Cookie 让 Server Component 在首帧输出
  // 正确的显式主题。该值不含敏感信息，SameSite=Lax 足以限制跨站携带。
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${THEME_COOKIE_NAME}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
