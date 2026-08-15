import { describe, expect, it } from "vitest";

import { resolveThemePreference } from "@/infrastructure/theme/preferences";

describe("resolveThemePreference", () => {
  it.each(["system", "light", "dark"] as const)(
    "保留受支持的主题偏好 %s",
    (preference) => {
      expect(resolveThemePreference(preference)).toBe(preference);
    },
  );

  it.each([undefined, null, "", "night", "<script>"])(
    "拒绝无效外部值 %s",
    (preference) => {
      expect(resolveThemePreference(preference)).toBe("system");
    },
  );
});
