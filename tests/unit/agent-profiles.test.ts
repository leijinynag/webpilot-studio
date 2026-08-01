import { describe, expect, it } from "vitest";

import { AGENT_ERROR_CODES } from "@/domains/agent/errors";
import {
  DEFAULT_MAX_AGENT_MODEL_TURNS,
  normalizeAgentRunBudget,
} from "@/domains/agent/types";
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
    expect(profile.promptProfile).toBe("webpilot-system-v5");
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
      "Revision 0 with zero files is a valid blank repository",
    );
    expect(resolved.prompt.content).toContain(
      "sequential file mutations -> final list_files -> run_preview -> browser_verify",
    );
    expect(resolved.prompt.content).toContain(
      "File writes and project activation never install dependencies",
    );
    expect(resolved.prompt.content).toContain(
      'package.json must set "type": "module"',
    );
    expect(resolved.prompt.content).toContain(
      "do not guess or change package.json, dependencies, scripts, or build config",
    );
    expect(resolved.prompt.content).toContain(
      "Never claim completion until the current revision",
    );
    expect(resolved.prompt.content).toContain(
      "For an informational or repository-inspection request, use the file tools as needed, answer the user and finish normally without previewing",
    );
    expect(resolved.prompt.content).toContain(
      "Do not call run_preview or browser_verify only to answer a read-only request",
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

  it("旧 Run 缺少模型轮次字段时使用新的空项目默认预算", () => {
    expect(normalizeAgentRunBudget({}).maxModelTurns).toBe(
      DEFAULT_MAX_AGENT_MODEL_TURNS,
    );
    expect(DEFAULT_MAX_AGENT_MODEL_TURNS).toBe(16);
    // 已冻结的显式预算仍保持原值，避免恢复旧 Run 时悄然改变执行边界。
    expect(normalizeAgentRunBudget({ maxModelTurns: 12 }).maxModelTurns).toBe(
      12,
    );
  });

  it("仍可解析冻结的 M4 Browser Prompt", () => {
    const prompt = resolveSystemPromptProfile("webpilot-system-v4", {
      locale: "zh-CN",
      projectId: "project-m4",
      revision: 4,
      repositoryCapability,
    });

    const resolved = assertFrozenProfilesAvailable({
      promptProfile: prompt.id,
      promptDigest: prompt.digest,
      toolsetProfile: "webpilot-browser-v3",
      toolsetDigest: resolveToolsetProfile("webpilot-browser-v3").digest,
      promptContext: {
        locale: "zh-CN",
        projectId: "project-m4",
        revision: 4,
        repositoryCapability,
      },
    });

    expect(resolved.prompt.content).toContain(
      "automatic replay or browser_verify",
    );
    expect(resolved.prompt.content).not.toContain(
      "Revision 0 with zero files is a valid blank repository",
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
