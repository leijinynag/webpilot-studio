import type { FileSystemTree } from "@webcontainer/api";

export type ProjectTemplateFile = {
  path: string;
  content: string;
};

/**
 * 将 WebContainer 的目录树转换成 Repository 使用的扁平文件列表。
 * 模板仍由 infrastructure/webcontainer/project-template.ts 单点维护，
 * 这里不复制任何模板内容，只负责把运行时结构投影成持久化结构。
 */
export function flattenProjectTemplate(
  tree: FileSystemTree,
  parentPath = "",
): ProjectTemplateFile[] {
  const files: ProjectTemplateFile[] = [];

  for (const [name, entry] of Object.entries(tree)) {
    const path = parentPath ? `${parentPath}/${name}` : name;

    if ("file" in entry && "contents" in entry.file) {
      files.push({
        path,
        content: entry.file.contents.toString(),
      });
      continue;
    }

    if ("directory" in entry) {
      files.push(...flattenProjectTemplate(entry.directory, path));
    }
  }

  return files;
}

/**
 * 将数据库中的扁平文件快照还原为 WebContainer.mount 接受的目录树。
 * 路径已经由 Repository 校验；这里仍检测文件/目录冲突，避免损坏的数据静默覆盖节点。
 */
export function buildProjectTemplate(
  files: readonly ProjectTemplateFile[],
): FileSystemTree {
  const root: FileSystemTree = {};

  for (const file of files) {
    const segments = file.path.split("/");
    let directory = root;

    for (const [index, segment] of segments.entries()) {
      const isFile = index === segments.length - 1;

      if (isFile) {
        if (directory[segment]) {
          throw new Error(`项目路径发生文件冲突：${file.path}`);
        }

        directory[segment] = {
          file: { contents: file.content },
        };
        continue;
      }

      const existing = directory[segment];

      if (!existing) {
        const nextDirectory: FileSystemTree = {};
        directory[segment] = { directory: nextDirectory };
        directory = nextDirectory;
        continue;
      }

      if (!("directory" in existing)) {
        throw new Error(`项目路径发生目录冲突：${file.path}`);
      }

      directory = existing.directory;
    }
  }

  return root;
}
