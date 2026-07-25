"use client";

import * as React from "react";

export type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "webpilot-theme-v1";

let currentPreference: ThemePreference = "system";
const themeListeners = new Set<() => void>();

if (typeof window !== "undefined") {
  const storedPreference = window.localStorage.getItem(THEME_STORAGE_KEY);

  if (
    storedPreference === "light" ||
    storedPreference === "dark" ||
    storedPreference === "system"
  ) {
    currentPreference = storedPreference;
  }
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

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}

function getThemePreference() {
  return currentPreference;
}

function getServerThemePreference() {
  return "system" as const;
}

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = React.useSyncExternalStore(
    subscribeToTheme,
    getThemePreference,
    getServerThemePreference,
  );

  React.useEffect(() => {
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
    // 存储协议带版本号，未来变更字段时可以平滑迁移而不污染旧值。
    window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
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
