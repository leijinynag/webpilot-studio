import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import {
  assertFrozenProfilesAvailable,
  createFrozenAgentProfile,
} from "@/domains/agent/profiles";

const repositoryCapability = {
  storageKind: "database" as const,
  canRead: true,
  canWrite: true,
  canExecuteServerTools: true,
};

describe("Agent profiles", () => {
  it("freezes versioned prompt and toolset digests", () => {
    const profile = createFrozenAgentProfile({
      locale: "zh-CN",
      projectId: "project-1",
      revision: 3,
      repositoryCapability,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      maxModelTurns: 12,
      maxWallTimeSeconds: 300,
    });

    expect(profile.promptDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(profile.toolsetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      assertFrozenProfilesAvailable({
        promptProfile: profile.promptProfile,
        promptDigest: profile.promptDigest,
        toolsetProfile: profile.toolsetProfile,
        toolsetDigest: profile.toolsetDigest,
        promptContext: {
          locale: profile.locale,
          projectId: "project-1",
          revision: 3,
          repositoryCapability,
        },
      }).prompt.content,
    ).toContain("Current frozen revision: 3");
  });

  it("fails explicitly when a frozen digest is unavailable", () => {
    expect(() =>
      assertFrozenProfilesAvailable({
        promptProfile: "webpilot-system-v1",
        promptDigest: "stale",
        toolsetProfile: "webpilot-files-v1",
        toolsetDigest: "stale",
        promptContext: {
          locale: "zh-CN",
          projectId: "project-1",
          revision: 1,
          repositoryCapability,
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: AGENT_ERROR_CODES.profileUnavailable }),
    );
  });
});
