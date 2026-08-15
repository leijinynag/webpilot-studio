import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";
import { assertValidProjectPath } from "@/domains/project/path";
import type { ProjectFileMutation } from "@/domains/project/types";

/**
 * 批量 mutation 在进入具体存储实现前先完成统一校验。
 *
 * 稳定排序不仅让 changedPaths 和测试结果可预测，也让 Database 与 Browser Git
 * 在相同输入下采用一致的执行顺序。一次批次内禁止重复路径，避免“先写后删”
 * 之类依赖调用顺序的隐含语义。
 */
export function normalizeProjectFileMutations(
  mutations: readonly ProjectFileMutation[],
): ProjectFileMutation[] {
  if (mutations.length === 0) {
    throw new ProjectError(
      PROJECT_ERROR_CODES.invalidRequest,
      "批量文件操作不能为空。",
      400,
    );
  }

  const normalized = mutations.map((mutation) => ({
    ...mutation,
    path: assertValidProjectPath(mutation.path),
  }));
  const paths = new Set<string>();

  for (const mutation of normalized) {
    if (paths.has(mutation.path)) {
      throw new ProjectError(
        PROJECT_ERROR_CODES.pathConflict,
        "同一批文件操作不能重复修改相同路径。",
        409,
        { path: mutation.path },
      );
    }
    paths.add(mutation.path);
  }

  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}
