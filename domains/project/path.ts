import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";

const RESERVED_ROOT_SEGMENTS = new Set([".git", "node_modules"]);

export function assertValidProjectPath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.includes("\0")
  ) {
    throwInvalidPath(path);
  }

  // Repository 内统一使用 POSIX 分隔符。反斜线既可能隐藏 Windows 绝对路径，
  // 也会导致浏览器与数据库对同一文件产生两种路径解释，因此直接拒绝。
  if (path.includes("\\")) {
    throwInvalidPath(path);
  }

  const segments = path.split("/");

  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    RESERVED_ROOT_SEGMENTS.has(segments[0]!)
  ) {
    throwInvalidPath(path);
  }

  return path;
}

function throwInvalidPath(path: string): never {
  throw new ProjectError(
    PROJECT_ERROR_CODES.invalidPath,
    "项目文件路径不合法或属于保留目录。",
    400,
    { path },
  );
}
