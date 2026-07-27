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
