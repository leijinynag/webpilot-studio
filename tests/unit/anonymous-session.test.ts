import { describe, expect, it } from "vitest";

import {
  createAnonymousSession,
  verifyAnonymousSession,
} from "@/domains/auth/anonymous-session";

const TEST_SECRET = "test-secret-that-is-long-enough-for-session-signing";

describe("anonymous session", () => {
  it("creates a high-entropy owner and verifies the signed cookie", () => {
    const created = createAnonymousSession(1_750_000_000_000, TEST_SECRET);

    expect(created.session.ownerId.length).toBeGreaterThanOrEqual(40);
    expect(verifyAnonymousSession(created.cookieValue, TEST_SECRET)).toEqual(
      created.session,
    );
  });

  it("rejects a tampered cookie instead of trusting its owner payload", () => {
    const created = createAnonymousSession(1_750_000_000_000, TEST_SECRET);
    const [payload, signature] = created.cookieValue.split(".");
    const tamperedPayload = `${payload?.slice(0, -1)}A`;

    expect(
      verifyAnonymousSession(`${tamperedPayload}.${signature}`, TEST_SECRET),
    ).toBeNull();
  });
});
