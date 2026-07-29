import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import {
  assertFrozenProfilesAvailable,
  createFrozenAgentProfile,
  resolveSystemPromptProfile,
  resolveToolsetProfile,
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
    expect(profile.promptProfile).toBe("webpilot-system-v4");
    expect(profile.toolsetProfile).toBe("webpilot-browser-v3");
    const resolved = assertFrozenProfilesAvailable({
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
    });
    expect(resolved.prompt.content).toContain("Current frozen revision: 3");
    expect(resolved.prompt.content).toContain(
      "evidence -> search -> read -> one mutation -> automatic replay or browser_verify",
    );
    expect(resolved.prompt.content).toContain(
      "Never claim completion until the current revision",
    );
    expect(profile.budget).toMatchObject({
      maxFileMutations: 8,
      maxClientResumes: 6,
      maxNoProgressRepeats: 2,
    });
    expect(resolved.toolset.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["run_preview", "browser_verify"]),
    );
  });

  it("仍可解析冻结的 M3 Prompt 与 Preview Toolset", () => {
    const prompt = resolveSystemPromptProfile("webpilot-system-v3", {
      locale: "zh-CN",
      projectId: "project-legacy",
      revision: 7,
      repositoryCapability,
    });
    const toolset = resolveToolsetProfile("webpilot-preview-v2");

    const resolved = assertFrozenProfilesAvailable({
      promptProfile: prompt.id,
      promptDigest: prompt.digest,
      toolsetProfile: toolset.id,
      toolsetDigest: toolset.digest,
      promptContext: {
        locale: "zh-CN",
        projectId: "project-legacy",
        revision: 7,
        repositoryCapability,
      },
    });

    expect(resolved.prompt.content).toContain("one mutation -> run_preview");
    expect(resolved.toolset.tools.map((tool) => tool.name)).toContain(
      "run_preview",
    );
    expect(resolved.toolset.tools.map((tool) => tool.name)).not.toContain(
      "browser_verify",
    );
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
