import type { Metadata } from "next";
import { Geist, Instrument_Serif } from "next/font/google";
import Script from "next/script";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
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
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
