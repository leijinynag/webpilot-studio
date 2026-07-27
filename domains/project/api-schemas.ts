import { z } from "zod";

const projectIdSchema = z.uuid("项目 ID 格式不正确。");
const projectPathSchema = z
  .string()
  .trim()
  .min(1, "文件路径不能为空。")
  .max(500, "文件路径不能超过 500 个字符。");
const revisionSchema = z.number().int().nonnegative();
export const queryRevisionSchema = z.coerce.number().int().nonnegative();

export const createProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    storageKind: z.enum(["database", "browser_git"]).default("database"),
    template: z.enum(["rsbuild"]).default("rsbuild"),
  })
  .strict();

export const projectIdParamsSchema = z.object({
  projectId: projectIdSchema,
});

export const updateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    expectedRevision: revisionSchema,
  })
  .strict();

export const writeFileRequestSchema = z
  .object({
    path: projectPathSchema,
    content: z.string(),
    expectedRevision: revisionSchema,
  })
  .strict();

export const renameFileRequestSchema = z
  .object({
    fromPath: projectPathSchema,
    toPath: projectPathSchema,
    expectedRevision: revisionSchema,
  })
  .strict();

export const fileMutationRequestSchema = z
  .object({
    path: projectPathSchema,
    expectedRevision: queryRevisionSchema,
  })
  .strict();

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
