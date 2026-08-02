import { getRequestConfig } from "next-intl/server";

import { getRequestLocale } from "@/infrastructure/i18n/request-locale";
import { getMessages } from "@/infrastructure/i18n/messages";

export default getRequestConfig(async () => {
  const locale = await getRequestLocale();
  return {
    locale,
    messages: getMessages(locale),
  };
});
