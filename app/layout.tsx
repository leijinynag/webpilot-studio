import type { Metadata } from "next";
import { Geist, Instrument_Serif } from "next/font/google";
import Script from "next/script";
import { NextIntlClientProvider } from "next-intl";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UiI18nProvider } from "@/infrastructure/i18n/ui";
import { localeToHtmlLang } from "@/infrastructure/i18n/locale";
import { getRequestLocale } from "@/infrastructure/i18n/request-locale";
import { getMessages } from "@/infrastructure/i18n/messages";

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

  return (
    <html
      lang={localeToHtmlLang(locale)}
      className={`${geist.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {`
            (() => {
              try {
                const key = "webpilot-theme-v1";
                const stored = localStorage.getItem(key);
                const preference =
                  stored === "light" || stored === "dark" || stored === "system"
                    ? stored
                    : "system";
                const resolved =
                  preference === "system"
                    ? matchMedia("(prefers-color-scheme: dark)").matches
                      ? "dark"
                      : "light"
                    : preference;
                document.documentElement.dataset.theme = resolved;
                document.documentElement.classList.toggle("dark", resolved === "dark");
                document.documentElement.style.colorScheme = resolved;
              } catch {}
            })();
          `}
        </Script>
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <UiI18nProvider locale={locale} messages={messages}>
            <ThemeProvider>
              <TooltipProvider>{children}</TooltipProvider>
            </ThemeProvider>
          </UiI18nProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
