export type MigrationManifestEntry = {
  path: string;
  hash: string;
};

/**
 * 迁移清单使用稳定 JSON 编码：先按路径排序，再只保留 path/hash。
 *
 * 服务端与 Browser Git Worker 会分别对这段字符串计算 SHA-256。使用 JSON
 * 而不是字符串拼接，可以避免路径或摘要中出现分隔符时产生边界歧义。
 */
export function serializeMigrationManifest(
  entries: readonly MigrationManifestEntry[],
) {
  return JSON.stringify(
    [...entries]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({ path, hash }) => ({ path, hash })),
  );
}
