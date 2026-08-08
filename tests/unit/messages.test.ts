import { describe, expect, it } from "vitest";

import {
  getErrorMessageMap,
  getLocalizedErrorMessage,
} from "@/infrastructure/i18n/error-messages";
import { flattenMessageKeys } from "@/infrastructure/i18n/messages";
import en from "@/messages/en.json";
import zh from "@/messages/zh.json";

describe("message contracts", () => {
  it("keeps Chinese and English dictionaries structurally aligned", () => {
    expect(flattenMessageKeys(zh).sort()).toEqual(
      flattenMessageKeys(en).sort(),
    );
  });

  it("maps stable API error codes without displaying server text", () => {
    expect(getLocalizedErrorMessage("PROJECT_NOT_FOUND", "en")).toBe(
      "This project could not be found.",
    );
    expect(getLocalizedErrorMessage("PROJECT_NOT_FOUND", "zh")).toBe(
      "找不到这个项目。",
    );
    expect(getLocalizedErrorMessage("UNKNOWN_CODE", "en")).toBe(
      getErrorMessageMap("en").INTERNAL_ERROR,
    );
  });
});
