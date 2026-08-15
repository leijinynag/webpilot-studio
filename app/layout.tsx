import type { Metadata } from "next";
import { Geist, Instrument_Serif } from "next/font/google";
import { cookies } from "next/headers";
import Script from "next/script";
import { NextIntlClientProvider } from "next-intl";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UiI18nProvider } from "@/infrastructure/i18n/ui";
import { localeToHtmlLang } from "@/infrastructure/i18n/locale";
import { getRequestLocale } from "@/infrastructure/i18n/request-locale";
import { getMessages } from "@/infrastructure/i18n/messages";
import {
  THEME_COOKIE_NAME,
  resolveThemePreference,
} from "@/infrastructure/theme/preferences";

import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-ui",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-editorial",
  weight: "400",
});

export const metadata: Metadata = {
  title: "WebPilot Studio",
  description: "An agentic web IDE for building and verifying React projects.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getRequestLocale();
  const messages = getMessages(locale);
  const cookieStore = await cookies();
  const rawThemeCookie = cookieStore.get(THEME_COOKIE_NAME)?.value;
  const initialThemePreference = resolveThemePreference(
    rawThemeCookie,
  );
  const hasValidThemeCookie =
    rawThemeCookie === "system" ||
    rawThemeCookie === "light" ||
    rawThemeCookie === "dark";
  const explicitTheme =
    initialThemePreference === "system" ? undefined : initialThemePreference;

  return (
    <html
      lang={localeToHtmlLang(locale)}
      className={`${geist.variable} ${instrumentSerif.variable} ${
        explicitTheme === "dark" ? "dark" : ""
      }`.trim()}
      data-theme={explicitTheme}
      style={{ colorScheme: explicitTheme }}
      suppressHydrationWarning
    >
      <body>
        <Script id="theme-init" strategy="beforeInteractive">
          {`
            (() => {
              try {
                const serverPreference = ${JSON.stringify(initialThemePreference)};
                const hasValidCookie = ${JSON.stringify(hasValidThemeCookie)};
                const stored = localStorage.getItem("webpilot-theme-v1");
                const storedPreference =
                  stored === "light" || stored === "dark" || stored === "system"
                    ? stored
                    : null;

                // Cookie 是 SSR 的首帧事实来源；旧用户尚无 Cookie 时才读取
                // localStorage 完成一次兼容迁移。system 模式仍需在首屏解析系统偏好。
                const preference =
                  hasValidCookie ? serverPreference : (storedPreference ?? serverPreference);
                const resolved =
                  preference === "system"
                    ? matchMedia("(prefers-color-scheme: dark)").matches
                      ? "dark"
                      : "light"
                    : preference;
                const root = document.documentElement;

                root.dataset.theme = resolved;
                root.classList.toggle("dark", resolved === "dark");
                root.style.colorScheme = resolved;

                // Cookie 已经是服务端首帧事实来源时，同步覆盖可能过期的本地值。
                // 这样客户端主题 Store 初始化后不会把旧 localStorage 再写回页面。
                if (hasValidCookie) {
                  localStorage.setItem("webpilot-theme-v1", serverPreference);
                }
              } catch {}
            })();
          `}
        </Script>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <UiI18nProvider locale={locale} messages={messages}>
            <ThemeProvider initialPreference={initialThemePreference}>
              <TooltipProvider>{children}</TooltipProvider>
            </ThemeProvider>
          </UiI18nProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
