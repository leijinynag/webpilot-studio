import { createHash } from "node:crypto";

import { AGENT_ERROR_CODES, AgentError } from "@/domains/agent/errors";
import { RUN_PREVIEW_TOOL_DEFINITION } from "@/domains/agent/client-tool-contracts";
import { FILE_TOOL_DEFINITIONS } from "@/domains/agent/tool-contracts";
import type {
  AgentLocale,
  FrozenAgentRunProfile,
  RepositoryCapability,
} from "@/domains/agent/types";

const SYSTEM_PROMPT_PROFILE_V1_ID = "webpilot-system-v1";
const FILE_TOOLSET_PROFILE_V1_ID = "webpilot-files-v1";
export const SYSTEM_PROMPT_PROFILE_ID = "webpilot-system-v2";
export const FILE_TOOLSET_PROFILE_ID = "webpilot-preview-v2";
// 领域层只记录“编码 Agent 模型配置”这一能力，不绑定具体供应商。
// 当前可用的 DeepSeek adapter 在 infrastructure 层完成映射，未来替换
// Provider 时不需要修改 Agent Run、Transcript 或 Orchestrator。
export const CODING_AGENT_MODEL_PROFILE_ID = "coding-agent-v1";

type SystemPromptContext = {
  locale: AgentLocale;
  projectId: string;
  revision: number;
  repositoryCapability: RepositoryCapability;
};

const SYSTEM_PROMPT_PROFILES = {
  [SYSTEM_PROMPT_PROFILE_V1_ID]: (context: SystemPromptContext) => {
    const responseLanguage =
      context.locale === "zh-CN" ? "简体中文" : "English";

    return [
      "You are the coding agent inside WebPilot Studio.",
      `Respond to the user in ${responseLanguage}.`,
      `Repository storage: ${context.repositoryCapability.storageKind}.`,
      `Project id: ${context.projectId}. Current frozen revision: ${context.revision}.`,
      "",
      "Repository rules:",
      "1. Inspect the repository with list_files/search_text before choosing files.",
      "2. Read an existing file before write_file, delete_file, or rename_file touches it.",
      "3. Perform at most one file mutation per model turn and use the latest expectedRevision.",
      "4. After a mutation, continue from the returned revision. Never guess a revision.",
      "5. Keep changes minimal and preserve the existing project conventions.",
      "",
      "Verification and stopping rules:",
      "1. File tools prove only repository state; do not claim build or browser verification.",
      "2. Stop immediately on cancellation, revision conflict, invalid tool result, or exhausted budget.",
      "3. When the requested edit is complete, explain what changed and any verification still required.",
      "4. Do not call tools after the task is complete.",
    ].join("\n");
  },
  [SYSTEM_PROMPT_PROFILE_ID]: (context: SystemPromptContext) => {
    const responseLanguage =
      context.locale === "zh-CN" ? "简体中文" : "English";

    return [
      "You are the coding agent inside WebPilot Studio.",
      `Respond to the user in ${responseLanguage}.`,
      `Repository storage: ${context.repositoryCapability.storageKind}.`,
      `Project id: ${context.projectId}. Current frozen revision: ${context.revision}.`,
      "",
      "Repository rules:",
      "1. Inspect the repository with list_files/search_text before choosing files.",
      "2. Read an existing file before write_file, delete_file, or rename_file touches it.",
      "3. Perform at most one file mutation per model turn and use the latest expectedRevision.",
      "4. After a mutation, continue from the returned revision. Never guess a revision.",
      "5. Keep changes minimal and preserve the existing project conventions.",
      "",
      "Verification and repair rules:",
      "1. After the requested code mutation, call run_preview with the latest revision before claiming success.",
      "2. Treat run_preview as the source of truth for install, dev-server, runtime and console evidence.",
      "3. If preview fails, inspect its structured evidence, repair the code, and run_preview again.",
      "4. Console warnings are evidence but do not automatically require a code change; runtime or console errors do.",
      "5. Never claim browser verification from file tools alone.",
      "",
      "Stopping rules:",
      "1. Stop immediately on cancellation, revision conflict, invalid tool result, or exhausted budget.",
      "2. Finish only after the latest revision has a successful run_preview result.",
      "3. In the final response, summarize changed files and the observed preview evidence.",
      "4. Do not call tools after the task is complete.",
    ].join("\n");
  },
} satisfies Record<string, (context: SystemPromptContext) => string>;

const TOOLSET_PROFILES = {
  [FILE_TOOLSET_PROFILE_V1_ID]: FILE_TOOL_DEFINITIONS,
  [FILE_TOOLSET_PROFILE_ID]: [
    ...FILE_TOOL_DEFINITIONS,
    RUN_PREVIEW_TOOL_DEFINITION,
  ],
} as const;

export function resolveSystemPromptProfile(
  profileId: string,
  context: SystemPromptContext,
): { id: string; digest: string; content: string } {
  const factory =
    SYSTEM_PROMPT_PROFILES[profileId as keyof typeof SYSTEM_PROMPT_PROFILES];

  if (!factory) {
    throw new AgentError(
      AGENT_ERROR_CODES.profileUnavailable,
      `System Prompt profile ${profileId} 在当前部署中不可用。`,
      500,
      { profileId },
    );
  }

  const content = factory(context);
  return { id: profileId, content, digest: sha256(content) };
}

export function resolveToolsetProfile(profileId: string) {
  const tools = TOOLSET_PROFILES[profileId as keyof typeof TOOLSET_PROFILES];

  if (!tools) {
    throw new AgentError(
      AGENT_ERROR_CODES.profileUnavailable,
      `Toolset profile ${profileId} 在当前部署中不可用。`,
      500,
      { profileId },
    );
  }

  return {
    id: profileId,
    tools,
    digest: sha256(stableStringify(tools)),
  };
}

export function createFrozenAgentProfile(input: {
  locale: AgentLocale;
  projectId: string;
  revision: number;
  repositoryCapability: RepositoryCapability;
  provider: string;
  model: string;
  maxModelTurns: number;
  maxWallTimeSeconds: number;
}): FrozenAgentRunProfile {
  const prompt = resolveSystemPromptProfile(SYSTEM_PROMPT_PROFILE_ID, input);
  const toolset = resolveToolsetProfile(FILE_TOOLSET_PROFILE_ID);

  return {
    locale: input.locale,
    provider: input.provider,
    model: input.model,
    promptProfile: prompt.id,
    promptDigest: prompt.digest,
    toolsetProfile: toolset.id,
    toolsetDigest: toolset.digest,
    modelProfile: CODING_AGENT_MODEL_PROFILE_ID,
    repositoryCapability: input.repositoryCapability,
    budget: {
      maxModelTurns: input.maxModelTurns,
      maxWallTimeSeconds: input.maxWallTimeSeconds,
      maxOutputCharacters: 24_000,
      maxToolResultCharacters: 20_000,
    },
  };
}

export function assertFrozenProfilesAvailable(input: {
  promptProfile: string;
  promptDigest: string;
  toolsetProfile: string;
  toolsetDigest: string;
  promptContext: SystemPromptContext;
}) {
  const prompt = resolveSystemPromptProfile(
    input.promptProfile,
    input.promptContext,
  );
  const toolset = resolveToolsetProfile(input.toolsetProfile);

  if (
    prompt.digest !== input.promptDigest ||
    toolset.digest !== input.toolsetDigest
  ) {
    throw new AgentError(
      AGENT_ERROR_CODES.profileUnavailable,
      "冻结的 Prompt 或 Toolset 与当前部署版本不一致。",
      500,
    );
  }

  return { prompt, toolset };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nestedValue]) =>
          `${JSON.stringify(key)}:${stableStringify(nestedValue)}`,
      )
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
