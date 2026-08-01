import type { RepositoryIntent } from "@/domains/agent/types";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const EXPLICIT_COMMIT_PATTERNS = [
  /\bgit\s+commit\b/i,
  /\bcommit(?:\s+(?:the|these|my|current|staged|all))?\s+(?:change|changes|code|files?)\b/i,
  /(?:创建|进行|执行|做一次|帮我|请)?\s*(?:git\s*)?(?:提交|commit)\s*(?:代码|改动|变更|文件|暂存内容|记录)/i,
  /(?:把|将).{0,30}(?:提交到|commit\s+to)\s*(?:git|本地仓库|仓库)/i,
];
const EXPLICIT_STAGE_PATTERNS = [
  /\bgit\s+(?:add|stage)\b/i,
  /\bstage\s+(?:the|these|my|current|all|file|files|change|changes)\b/i,
  /(?:加入|添加到|放入|执行|进行|帮我|请).{0,20}(?:暂存区|stage)/i,
  /(?:暂存|stage)\s*(?:这些|当前|全部|文件|改动|变更)/i,
];
const EXPLICIT_UNSTAGE_PATTERNS = [
  /\bgit\s+(?:restore\s+--staged|reset(?:\s+HEAD)?)\b/i,
  /\bunstage\s+(?:the|these|my|current|all|file|files|change|changes)\b/i,
  /(?:取消|撤销|移出).{0,12}(?:暂存|stage)/i,
];

/**
 * 模型生成的 Tool Call 只是执行建议，不代表用户授权。
 *
 * 这里故意采用保守的显式短语匹配：没有明确 Git 语义时，“提交表单”、
 * “提交审核”等普通产品需求都不能开启 commit 权限。身份同样必须来自原始
 * 消息，缺少姓名或邮箱时保留 commit 意图，但执行阶段仍会拒绝真正提交。
 */
export function deriveRepositoryIntent(message: string): RepositoryIntent {
  const normalizedMessage = message.trim();
  const allowCommit = matchesAny(normalizedMessage, EXPLICIT_COMMIT_PATTERNS);

  return {
    allowStage: matchesAny(normalizedMessage, EXPLICIT_STAGE_PATTERNS),
    allowUnstage: matchesAny(normalizedMessage, EXPLICIT_UNSTAGE_PATTERNS),
    allowCommit,
    commitAuthor: allowCommit ? extractCommitAuthor(normalizedMessage) : null,
  };
}

export function normalizeRepositoryIntent(
  intent: RepositoryIntent | undefined,
): RepositoryIntent {
  return {
    allowStage: intent?.allowStage === true,
    allowUnstage: intent?.allowUnstage === true,
    allowCommit: intent?.allowCommit === true,
    commitAuthor:
      typeof intent?.commitAuthor?.name === "string" &&
      intent.commitAuthor.name.trim().length > 0 &&
      typeof intent.commitAuthor.email === "string" &&
      EMAIL_PATTERN.test(intent.commitAuthor.email)
        ? {
            name: intent.commitAuthor.name.trim(),
            email: intent.commitAuthor.email.trim(),
          }
        : null,
  };
}

function extractCommitAuthor(
  message: string,
): RepositoryIntent["commitAuthor"] {
  const emailMatch = message.match(EMAIL_PATTERN);
  if (!emailMatch) {
    return null;
  }

  const email = emailMatch[0];
  const escapedEmail = escapeRegExp(email);
  const namePatterns = [
    new RegExp(
      `(?:author\\s*name|git\\s*author|作者(?:姓名)?|提交者(?:姓名)?)\\s*[:：=]\\s*([^\\n,，;；<>]{1,80})`,
      "i",
    ),
    new RegExp(`([^\\n,，;；<>]{1,80})\\s*<\\s*${escapedEmail}\\s*>`, "i"),
    new RegExp(
      `(?:使用|用|以|as)\\s+([^\\n,，;；<>]{1,80})\\s+(?:和|及|with|,)\\s*${escapedEmail}`,
      "i",
    ),
  ];

  for (const pattern of namePatterns) {
    const match = message.match(pattern);
    const name = match?.[1]?.trim();
    if (name) {
      return { name, email };
    }
  }

  return null;
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
