import type { Metadata } from "next";
import { Geist, Instrument_Serif } from "next/font/google";
import { cookies } from "next/headers";
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
  const initialThemePreference = resolveThemePreference(rawThemeCookie);
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
