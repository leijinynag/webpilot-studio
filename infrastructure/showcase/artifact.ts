import { zipSync } from "fflate";

import { assertValidProjectPath } from "@/domains/project/path";

export type ShowcaseArtifactFile = {
  path: string;
  content: Uint8Array;
  byteLength: number;
  hash: string;
};

export type ShowcaseArtifactManifest = {
  format: "webpilot-showcase-artifact-v1";
  entryPath: "index.html";
  files: Array<{
    path: string;
    byteLength: number;
    hash: string;
  }>;
  totalBytes: number;
  createdAt: string;
};

export type ShowcaseArtifact = {
  archive: Uint8Array;
  manifest: ShowcaseArtifactManifest;
  files: ShowcaseArtifactFile[];
};

/**
 * 生产构建产物必须是可被普通静态服务器托管的相对路径。
 * 这里同时承担 ZIP 清单和 Showcase Runtime 的输入校验，避免构建阶段
 * 允许了一个路径、发布阶段又用另一套规则读取。
 */
export function normalizeArtifactPath(path: string): string {
  const normalized = path;

  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(normalized) ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("//")
  ) {
    throw new Error(`产物路径不合法：${path}`);
  }

  return assertValidProjectPath(normalized);
}

/**
 * 静态站点常见的根绝对路径在独立域名或 ZIP 子目录中会失效。
 * 只改写站点自己的根路径引用，外部 URL 保持原样，绝不把外部资源
 * 代理进 WebPilot，也不改变 data:、blob: 等浏览器内置协议。
 */
export function rewriteStaticAssetReferences(
  path: string,
  content: Uint8Array,
): Uint8Array {
  if (!/\.(html?|css)$/i.test(path)) {
    return content;
  }

  const text = new TextDecoder().decode(content);
  const rewritten = text
    .replace(
      /(\b(?:src|href|action)\s*=\s*["'])\/(?!\/)/gi,
      "$1./",
    )
    .replace(/(\burl\(\s*["']?)\/(?!\/)/gi, "$1./");

  return new TextEncoder().encode(rewritten);
}

export async function createShowcaseArtifact(
  inputFiles: readonly { path: string; content: Uint8Array }[],
  createdAt = new Date().toISOString(),
): Promise<ShowcaseArtifact> {
  const files = new Map<string, Uint8Array>();

  for (const input of inputFiles) {
    const path = normalizeArtifactPath(input.path);
    if (files.has(path)) {
      throw new Error(`产物中存在重复文件：${path}`);
    }

    files.set(path, rewriteStaticAssetReferences(path, input.content));
  }

  if (!files.has("index.html")) {
    throw new Error("生产构建产物缺少入口文件 dist/index.html。");
  }

  const artifactFiles: ShowcaseArtifactFile[] = [];
  let totalBytes = 0;

  for (const [path, content] of [...files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const hash = await sha256Hex(content);
    const byteLength = content.byteLength;
    totalBytes += byteLength;
    artifactFiles.push({ path, content, byteLength, hash });
  }

  const manifest: ShowcaseArtifactManifest = {
    format: "webpilot-showcase-artifact-v1",
    entryPath: "index.html",
    files: artifactFiles.map(({ path, byteLength, hash }) => ({
      path,
      byteLength,
      hash,
    })),
    totalBytes,
    createdAt,
  };
  const archiveEntries: Record<string, Uint8Array> = {};

  for (const file of artifactFiles) {
    archiveEntries[file.path] = file.content;
  }
  archiveEntries["webpilot-artifact.json"] = new TextEncoder().encode(
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    archive: zipSync(archiveEntries, { level: 6 }),
    manifest,
    files: artifactFiles,
  };
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  // DOM 的 BufferSource 类型在不同 TypeScript 版本中对 SharedArrayBuffer
  // 的兼容范围不同。复制到普通 ArrayBuffer 后，浏览器和 Node 的 Web Crypto
  // 都能接受同一份确定输入。
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
