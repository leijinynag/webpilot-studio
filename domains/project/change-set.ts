import type {
  ProjectChangeOperation,
  ProjectRestoreConflict,
  ProjectRestoreImpact,
  ProjectRevisionManifestEntry,
} from "@/domains/project/types";

export type ComputedChangeSetFile = {
  operation: ProjectChangeOperation;
  pathBefore: string | null;
  pathAfter: string | null;
  beforeHash: string | null;
  afterHash: string | null;
};

export type RestorePlan = {
  impacts: ProjectRestoreImpact[];
  conflicts: ProjectRestoreConflict[];
};

/**
 * 比较两个完整 revision manifest，生成稳定排序的文件级 ChangeSet。
 *
 * rename 没有额外依赖文件操作日志，而是由“相同内容 hash 的 delete + create”
 * 推导。若同一 hash 同时出现多组路径，按路径排序后一一配对，保证服务端重试
 * 和测试环境都能得到完全相同的结果。
 */
export function computeChangeSet(
  baseEntries: readonly ProjectRevisionManifestEntry[],
  resultEntries: readonly ProjectRevisionManifestEntry[],
): ComputedChangeSetFile[] {
  const base = toManifest(baseEntries);
  const result = toManifest(resultEntries);
  const updates: ComputedChangeSetFile[] = [];
  const deletedByHash = new Map<string, string[]>();
  const createdByHash = new Map<string, string[]>();

  for (const path of sortedUnion(base.keys(), result.keys())) {
    const beforeHash = base.get(path) ?? null;
    const afterHash = result.get(path) ?? null;

    if (beforeHash === afterHash) {
      continue;
    }

    if (beforeHash && afterHash) {
      updates.push({
        operation: "update",
        pathBefore: path,
        pathAfter: path,
        beforeHash,
        afterHash,
      });
      continue;
    }

    if (beforeHash) {
      appendHashPath(deletedByHash, beforeHash, path);
    } else if (afterHash) {
      appendHashPath(createdByHash, afterHash, path);
    }
  }

  const renames: ComputedChangeSetFile[] = [];
  for (const hash of sortedUnion(deletedByHash.keys(), createdByHash.keys())) {
    const deletedPaths = deletedByHash.get(hash)?.sort(compareText) ?? [];
    const createdPaths = createdByHash.get(hash)?.sort(compareText) ?? [];
    const pairCount = Math.min(deletedPaths.length, createdPaths.length);

    for (let index = 0; index < pairCount; index += 1) {
      renames.push({
        operation: "rename",
        pathBefore: deletedPaths[index] ?? null,
        pathAfter: createdPaths[index] ?? null,
        beforeHash: hash,
        afterHash: hash,
      });
    }

    deletedByHash.set(hash, deletedPaths.slice(pairCount));
    createdByHash.set(hash, createdPaths.slice(pairCount));
  }

  const deletes = flattenHashPaths(deletedByHash, "delete");
  const creates = flattenHashPaths(createdByHash, "create");

  return [...renames, ...updates, ...deletes, ...creates].sort(compareChanges);
}

/**
 * Restore 使用三方比较，而不是把旧 manifest 整体覆盖到当前项目：
 *
 * - current === result：该路径仍保持 Agent 结束时状态，可以反向应用。
 * - current === base：该路径已经处于目标状态，不需要重复写入。
 * - 其余情况：checkpoint 后发生过用户 mutation，列为冲突。
 *
 * 调用方只要发现任一冲突就必须整笔拒绝，不能部分写入。
 */
export function computeRestorePlan(
  changes: readonly ComputedChangeSetFile[],
  currentEntries: readonly ProjectRevisionManifestEntry[],
): RestorePlan {
  const current = toManifest(currentEntries);
  const targetByPath = new Map<
    string,
    { resultHash: string | null; restoreHash: string | null }
  >();

  for (const change of changes) {
    if (change.pathBefore) {
      targetByPath.set(change.pathBefore, {
        resultHash:
          change.pathBefore === change.pathAfter ? change.afterHash : null,
        restoreHash: change.beforeHash,
      });
    }

    if (change.pathAfter && change.pathAfter !== change.pathBefore) {
      targetByPath.set(change.pathAfter, {
        resultHash: change.afterHash,
        restoreHash: null,
      });
    }
  }

  const impacts: ProjectRestoreImpact[] = [];
  const conflicts: ProjectRestoreConflict[] = [];

  for (const path of [...targetByPath.keys()].sort(compareText)) {
    const target = targetByPath.get(path);
    if (!target) {
      continue;
    }

    const currentHash = current.get(path) ?? null;
    const impact: ProjectRestoreImpact = {
      path,
      currentHash,
      resultHash: target.resultHash,
      restoreHash: target.restoreHash,
      action:
        currentHash === target.restoreHash
          ? "none"
          : target.restoreHash
            ? "write"
            : "delete",
    };
    impacts.push(impact);

    if (
      currentHash !== target.resultHash &&
      currentHash !== target.restoreHash
    ) {
      conflicts.push({
        path,
        currentHash,
        resultHash: target.resultHash,
        restoreHash: target.restoreHash,
        reason: getConflictReason(
          currentHash,
          target.resultHash,
          target.restoreHash,
        ),
      });
    }
  }

  return { impacts, conflicts };
}

export function summarizeChangeSet(
  changes: readonly ComputedChangeSetFile[],
): string {
  const counts = new Map<ProjectChangeOperation, number>();
  for (const change of changes) {
    counts.set(change.operation, (counts.get(change.operation) ?? 0) + 1);
  }

  const labels: Array<[ProjectChangeOperation, string]> = [
    ["create", "新增"],
    ["update", "修改"],
    ["delete", "删除"],
    ["rename", "重命名"],
  ];
  const parts = labels.flatMap(([operation, label]) => {
    const count = counts.get(operation) ?? 0;
    return count > 0 ? [`${label} ${count} 个`] : [];
  });

  return parts.length > 0 ? parts.join("，") : "未产生文件改动";
}

function toManifest(
  entries: readonly ProjectRevisionManifestEntry[],
): Map<string, string> {
  return new Map(entries.map((entry) => [entry.path, entry.hash]));
}

function appendHashPath(
  target: Map<string, string[]>,
  hash: string,
  path: string,
) {
  target.set(hash, [...(target.get(hash) ?? []), path]);
}

function flattenHashPaths(
  entries: ReadonlyMap<string, readonly string[]>,
  operation: "create" | "delete",
): ComputedChangeSetFile[] {
  const changes: ComputedChangeSetFile[] = [];

  for (const [hash, paths] of [...entries.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    for (const path of [...paths].sort(compareText)) {
      changes.push({
        operation,
        pathBefore: operation === "delete" ? path : null,
        pathAfter: operation === "create" ? path : null,
        beforeHash: operation === "delete" ? hash : null,
        afterHash: operation === "create" ? hash : null,
      });
    }
  }

  return changes;
}

function sortedUnion<T>(left: Iterable<T>, right: Iterable<T>): T[] {
  return [...new Set([...left, ...right])].sort((a, b) =>
    compareText(String(a), String(b)),
  );
}

function compareChanges(
  left: ComputedChangeSetFile,
  right: ComputedChangeSetFile,
) {
  const leftPath = left.pathAfter ?? left.pathBefore ?? "";
  const rightPath = right.pathAfter ?? right.pathBefore ?? "";
  return (
    compareText(leftPath, rightPath) ||
    compareText(left.pathBefore ?? "", right.pathBefore ?? "") ||
    compareText(left.operation, right.operation)
  );
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "en");
}

function getConflictReason(
  currentHash: string | null,
  resultHash: string | null,
  restoreHash: string | null,
): ProjectRestoreConflict["reason"] {
  if (currentHash === null) {
    return "deleted";
  }

  if (resultHash === null && restoreHash !== null) {
    return "created";
  }

  return "modified";
}
