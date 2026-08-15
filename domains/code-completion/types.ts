import { z } from "zod";

export const CODE_COMPLETION_LANGUAGES = [
  "typescript",
  "javascript",
  "css",
  "html",
  "json",
  "markdown",
  "plaintext",
] as const;

export type CodeCompletionLanguage = (typeof CODE_COMPLETION_LANGUAGES)[number];

export const CODE_COMPLETION_TRIGGERS = ["automatic", "explicit"] as const;
export type CodeCompletionTrigger = (typeof CODE_COMPLETION_TRIGGERS)[number];

const completionContextFileSchema = z
  .object({
    path: z.string().trim().min(1).max(240),
    content: z.string().max(32_000),
  })
  .strict();

/**
 * Browser Git 的源码只存在浏览器 IndexedDB 中，因此必须由客户端附带。
 * 这些文件仅可进入本次 Prompt，不能被服务端当成 Repository revision 事实。
 */
export const browserCodeCompletionContextSchema = z
  .object({
    files: z.array(completionContextFileSchema).max(40),
  })
  .strict()
  .superRefine((value, context) => {
    const totalCharacters = value.files.reduce(
      (sum, file) => sum + file.path.length + file.content.length,
      0,
    );

    if (totalCharacters > 120_000) {
      context.addIssue({
        code: "custom",
        message: "Browser Git 补全上下文超过 120,000 字符限制。",
        path: ["files"],
      });
    }
  });

export const codeCompletionRequestSchema = z
  .object({
    clientRequestId: z.uuid(),
    projectRevision: z.number().int().nonnegative(),
    path: z.string().trim().min(1).max(240),
    language: z.enum(CODE_COMPLETION_LANGUAGES),
    position: z
      .object({
        lineNumber: z.number().int().positive(),
        column: z.number().int().positive(),
      })
      .strict(),
    prefix: z.string().max(16_000),
    suffix: z.string().max(8_000),
    trigger: z.enum(CODE_COMPLETION_TRIGGERS),
    browserContext: browserCodeCompletionContextSchema.optional(),
  })
  .strict();

export type CodeCompletionRequest = z.infer<typeof codeCompletionRequestSchema>;

export const CODE_COMPLETION_EMPTY_REASONS = [
  "no_suggestion",
  "in_flight",
  "stale_revision",
  "invalid_model_response",
  "completion_too_long",
  "completion_failed",
] as const;

export type CodeCompletionEmptyReason =
  (typeof CODE_COMPLETION_EMPTY_REASONS)[number];

export const codeCompletionResponseSchema = z
  .object({
    requestId: z.uuid(),
    projectRevision: z.number().int().nonnegative(),
    insertText: z.string().max(6_000),
    model: z.string().trim().min(1).max(160),
    latencyMs: z.number().int().nonnegative(),
    firstResultLatencyMs: z.number().int().nonnegative(),
    cacheHit: z.boolean(),
    reason: z.enum(CODE_COMPLETION_EMPTY_REASONS).optional(),
  })
  .strict();

export type CodeCompletionResponse = z.infer<
  typeof codeCompletionResponseSchema
>;

export type CodeCompletionSourceFile = {
  path: string;
  content: string;
};

export type CodeCompletionPromptContext = {
  projectFileIndex: string[];
  relatedFiles: CodeCompletionSourceFile[];
  packageJson: CodeCompletionSourceFile | null;
  styleHint: string;
};
