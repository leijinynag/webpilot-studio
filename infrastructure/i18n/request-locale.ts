import "server-only";

import { cookies, headers } from "next/headers";

import {
  LOCALE_COOKIE_NAME,
  resolveLocale,
  type Locale,
} from "@/infrastructure/i18n/locale";

export async function getRequestLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  return resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE_NAME)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });
}
