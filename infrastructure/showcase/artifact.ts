import { zipSync } from "fflate";

import { assertValidProjectPath } from "@/domains/project/path";

export type ShowcaseArtifactFile = {
  path: string;
  content: Uint8Array;
  byteLength: number;
  hash: string;
};

export type ShowcaseArtifactUploadFile = {
  path: string;
  content: Uint8Array;
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

// Showcase 只接受有限大小的静态产物，避免一次发布占满 Blob、函数内存或浏览器
// 的 base64 请求体。单文件数量上限仍由 API schema 约束，所有入口共用这个总大小上限。
export const MAX_SHOWCASE_ARTIFACT_BYTES = 50 * 1024 * 1024;

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
    .replace(/(\b(?:src|href|action)\s*=\s*["'])\/(?!\/)/gi, "$1./")
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
  await validateShowcaseArtifactFiles({
    manifest,
    files: artifactFiles,
  });
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

/**
 * 发布前重新计算完整文件集合，不能信任浏览器传来的 hash、byteLength 或
 * totalBytes。这个函数不依赖数据库和 Blob，既能复用于 ZIP 构建，也能作为
 * 管理发布 API 的最后一道内容完整性校验。
 */
export async function validateShowcaseArtifactFiles(input: {
  manifest: ShowcaseArtifactManifest;
  files: readonly ShowcaseArtifactUploadFile[];
}): Promise<void> {
  const { manifest, files } = input;

  if (manifest.format !== "webpilot-showcase-artifact-v1") {
    throw new Error("artifact manifest 格式不受支持。");
  }

  if (manifest.entryPath !== "index.html") {
    throw new Error("artifact 入口文件必须是 index.html。");
  }

  if (!Number.isInteger(manifest.totalBytes) || manifest.totalBytes < 0) {
    throw new Error("artifact manifest 的 totalBytes 不合法。");
  }

  if (manifest.totalBytes > MAX_SHOWCASE_ARTIFACT_BYTES) {
    throw new Error("artifact 总大小超过 50 MB 限制。");
  }

  if (files.length !== manifest.files.length) {
    throw new Error("artifact 文件与 manifest 数量不一致。");
  }

  const manifestFiles = new Map<
    string,
    ShowcaseArtifactManifest["files"][number]
  >();
  let manifestTotalBytes = 0;

  for (const manifestFile of manifest.files) {
    const path = normalizeArtifactPath(manifestFile.path);
    if (manifestFiles.has(path)) {
      throw new Error(`manifest 中存在重复文件：${path}`);
    }

    if (
      !Number.isInteger(manifestFile.byteLength) ||
      manifestFile.byteLength < 0 ||
      !/^[a-f0-9]{64}$/i.test(manifestFile.hash)
    ) {
      throw new Error(`manifest 文件元数据不合法：${path}`);
    }

    manifestFiles.set(path, manifestFile);
    manifestTotalBytes += manifestFile.byteLength;
  }

  if (!manifestFiles.has(manifest.entryPath)) {
    throw new Error("artifact manifest 缺少 index.html。");
  }

  if (manifestTotalBytes !== manifest.totalBytes) {
    throw new Error("artifact manifest 的 totalBytes 不正确。");
  }

  const uploadPaths = new Set<string>();
  let actualTotalBytes = 0;

  for (const file of files) {
    const path = normalizeArtifactPath(file.path);
    if (uploadPaths.has(path)) {
      throw new Error(`artifact 上传文件重复：${path}`);
    }
    uploadPaths.add(path);

    const manifestFile = manifestFiles.get(path);
    if (!manifestFile) {
      throw new Error(`artifact 文件未出现在 manifest 中：${path}`);
    }

    if (!/^[a-f0-9]{64}$/i.test(file.hash)) {
      throw new Error(`artifact 文件 hash 不合法：${path}`);
    }

    if (
      manifestFile.byteLength !== file.content.byteLength ||
      manifestFile.hash.toLowerCase() !== file.hash.toLowerCase()
    ) {
      throw new Error(`artifact 文件元数据与 manifest 不一致：${path}`);
    }

    const actualHash = await sha256Hex(file.content);
    if (actualHash !== manifestFile.hash.toLowerCase()) {
      throw new Error(`artifact 文件内容 hash 校验失败：${path}`);
    }

    actualTotalBytes += file.content.byteLength;
  }

  if (uploadPaths.size !== manifestFiles.size) {
    throw new Error("artifact 上传文件与 manifest 文件集合不一致。");
  }

  if (actualTotalBytes !== manifest.totalBytes) {
    throw new Error("artifact 文件实际大小与 manifest 不一致。");
  }
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
