import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  normalizeLocale,
  resolveAcceptLanguage,
  resolveLocale,
  toAgentLocale,
} from "@/infrastructure/i18n/locale";

describe("locale resolution", () => {
  it("follows cookie, Accept-Language, then the Chinese default", () => {
    expect(resolveLocale({ cookie: "en", acceptLanguage: "zh-CN" })).toBe("en");
    expect(resolveLocale({ acceptLanguage: "en-US,en;q=0.9" })).toBe("en");
    expect(resolveLocale({ acceptLanguage: "fr-FR,ja;q=0.8" })).toBe(
      DEFAULT_LOCALE,
    );
  });

  it("normalizes supported language variants and ignores q=0", () => {
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(resolveAcceptLanguage("zh-CN;q=0,en-US;q=0.8")).toBe("en");
  });

  it("maps UI locale to the frozen Agent locale", () => {
    expect(toAgentLocale("zh")).toBe("zh-CN");
    expect(toAgentLocale("en")).toBe("en-US");
  });
});
