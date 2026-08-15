import path from "node:path";

import type { ProviderMessage } from "@/domains/agent/types";
import type {
  CodeCompletionPromptContext,
  CodeCompletionRequest,
  CodeCompletionSourceFile,
} from "@/domains/code-completion/types";

const MAX_INDEX_FILES = 120;
const MAX_RELATED_FILES = 6;
const MAX_RELATED_FILE_CHARACTERS = 8_000;
const MAX_RELATED_TOTAL_CHARACTERS = 32_000;
const MAX_PACKAGE_JSON_CHARACTERS = 8_000;

const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

const RESOLVABLE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".css",
  ".scss",
] as const;

/**
 * 补全上下文选择保持为纯函数，Database Repository 与 Browser Git 可以共享。
 * 输入文件是否可信由 API 层决定；这里仅负责在固定预算内建立相关性更高的 Prompt。
 */
export function buildCodeCompletionPromptContext(
  request: CodeCompletionRequest,
  sourceFiles: readonly CodeCompletionSourceFile[],
): CodeCompletionPromptContext {
  const normalizedFiles = deduplicateFiles(sourceFiles);
  const fileByPath = new Map(
    normalizedFiles.map((file) => [file.path, file] as const),
  );
  const currentText = `${request.prefix}${request.suffix}`;
  const relatedFiles: CodeCompletionSourceFile[] = [];
  let relatedCharacters = 0;

  for (const specifier of extractImportSpecifiers(currentText)) {
    const resolvedPath = resolveRelativeImport(
      request.path,
      specifier,
      fileByPath,
    );
    const relatedFile = resolvedPath ? fileByPath.get(resolvedPath) : null;

    if (
      !relatedFile ||
      relatedFile.path === request.path ||
      relatedFiles.some((file) => file.path === relatedFile.path)
    ) {
      continue;
    }

    const content = relatedFile.content.slice(0, MAX_RELATED_FILE_CHARACTERS);
    if (relatedCharacters + content.length > MAX_RELATED_TOTAL_CHARACTERS) {
      break;
    }

    relatedFiles.push({ path: relatedFile.path, content });
    relatedCharacters += content.length;

    if (relatedFiles.length >= MAX_RELATED_FILES) {
      break;
    }
  }

  const packageFile = fileByPath.get("package.json");
  const packageJson = packageFile
    ? {
        path: packageFile.path,
        content: packageFile.content.slice(0, MAX_PACKAGE_JSON_CHARACTERS),
      }
    : null;

  return {
    projectFileIndex: normalizedFiles
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_INDEX_FILES),
    relatedFiles,
    packageJson,
    styleHint: inferCodeStyle(request.prefix),
  };
}

export function buildCodeCompletionMessages(input: {
  request: CodeCompletionRequest;
  context: CodeCompletionPromptContext;
}): ProviderMessage[] {
  const { request, context } = input;
  const lineLimit = request.trigger === "explicit" ? 40 : 12;

  return [
    {
      role: "system",
      content: [
        "You are an inline code completion engine.",
        "Return only the exact text to insert at the cursor.",
        "Do not explain, do not use Markdown fences, and do not repeat the existing prefix.",
        `The result must contain at most ${lineLimit} lines.`,
        "Prefer completing the current expression, JSX node, function body, or a small coherent block.",
        "Do not rewrite the whole file and do not introduce undeclared third-party dependencies.",
        "Return an empty response when there is no high-confidence useful completion.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Current file: ${request.path}`,
        `Language: ${request.language}`,
        `Cursor: ${request.position.lineNumber}:${request.position.column}`,
        `Trigger: ${request.trigger}`,
        `Detected style: ${context.styleHint}`,
        "",
        "Project file index:",
        formatFileIndex(context.projectFileIndex),
        "",
        "package.json:",
        context.packageJson?.content || "<not available>",
        "",
        "Related imported files:",
        formatRelatedFiles(context.relatedFiles),
        "",
        "Code before cursor:",
        "<PREFIX>",
        request.prefix,
        "</PREFIX>",
        "",
        "Code after cursor:",
        "<SUFFIX>",
        request.suffix,
        "</SUFFIX>",
      ].join("\n"),
    },
  ];
}

export function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  IMPORT_SPECIFIER_PATTERN.lastIndex = 0;

  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier?.startsWith(".")) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveRelativeImport(
  currentPath: string,
  specifier: string,
  fileByPath: ReadonlyMap<string, CodeCompletionSourceFile>,
): string | null {
  const currentDirectory = path.posix.dirname(currentPath);
  const basePath = path.posix.normalize(
    path.posix.join(currentDirectory, specifier),
  );
  const candidates = [
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.slice(1).map(
      (extension) => `${basePath}/index${extension}`,
    ),
  ];

  return candidates.find((candidate) => fileByPath.has(candidate)) ?? null;
}

function deduplicateFiles(
  files: readonly CodeCompletionSourceFile[],
): CodeCompletionSourceFile[] {
  const byPath = new Map<string, CodeCompletionSourceFile>();

  for (const file of files) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }

  return [...byPath.values()];
}

function inferCodeStyle(prefix: string): string {
  const nonEmptyLines = prefix
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-80);
  const tabIndented = nonEmptyLines.filter((line) => line.startsWith("\t"));
  const twoSpaceIndented = nonEmptyLines.filter((line) =>
    /^(?: {2})+\S/.test(line),
  );
  const singleQuotes = (prefix.match(/'/g) ?? []).length;
  const doubleQuotes = (prefix.match(/"/g) ?? []).length;
  const semicolonLines = nonEmptyLines.filter((line) =>
    /[;{]$/.test(line.trim()),
  );

  const indentation =
    tabIndented.length > twoSpaceIndented.length ? "tabs" : "2 spaces";
  const quotes =
    singleQuotes > doubleQuotes ? "single quotes" : "double quotes";
  const semicolons =
    semicolonLines.length >= Math.max(1, nonEmptyLines.length / 3)
      ? "semicolons"
      : "minimal semicolons";

  return `${indentation}, ${quotes}, ${semicolons}`;
}

function formatFileIndex(paths: readonly string[]): string {
  return paths.length > 0
    ? paths.map((filePath) => `- ${filePath}`).join("\n")
    : "- <empty project>";
}

function formatRelatedFiles(
  files: readonly CodeCompletionSourceFile[],
): string {
  if (files.length === 0) {
    return "<none resolved>";
  }

  return files
    .map(
      (file) =>
        `<RELATED_FILE path="${file.path}">\n${file.content}\n</RELATED_FILE>`,
    )
    .join("\n\n");
}
