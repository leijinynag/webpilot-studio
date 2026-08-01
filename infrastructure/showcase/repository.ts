import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { del, get, put } from "@vercel/blob";

import {
  getDatabase,
  runDatabaseTransaction,
} from "@/infrastructure/db/client";
import { serverEnv } from "@/infrastructure/env/server";
import {
  showcaseArtifacts,
  showcaseCases,
  type ShowcaseArtifactManifestRow,
  type ShowcaseCaseRow,
} from "@/infrastructure/db/schema";
import {
  normalizeArtifactPath,
  sha256Hex,
  type ShowcaseArtifactManifest,
} from "@/infrastructure/showcase/artifact";

export type ShowcaseCaseView = {
  id: string;
  projectId: string | null;
  title: string;
  slug: string;
  description: string | null;
  coverUrl: string | null;
  sortOrder: number;
  status: "draft" | "published" | "revoked";
  publishedAt: string | null;
  artifact: {
    id: string;
    sourceRevision: number;
    entryPath: "index.html";
    fileCount: number;
    totalBytes: number;
    createdAt: string;
  } | null;
};

export type ShowcasePublishInput = {
  caseId?: string;
  projectId?: string | null;
  title: string;
  slug: string;
  description?: string | null;
  coverUrl?: string | null;
  sortOrder?: number;
  sourceRevision: number;
  manifest: ShowcaseArtifactManifest;
  files: readonly {
    path: string;
    content: Uint8Array;
    hash: string;
  }[];
};

export async function listShowcaseCandidates(): Promise<ShowcaseCaseView[]> {
  const database = getDatabase();
  const rows = await database
    .select({
      case: showcaseCases,
      artifact: showcaseArtifacts,
    })
    .from(showcaseCases)
    .leftJoin(
      showcaseArtifacts,
      and(
        eq(showcaseArtifacts.caseId, showcaseCases.id),
        eq(showcaseArtifacts.status, "active"),
      ),
    )
    .orderBy(asc(showcaseCases.sortOrder), desc(showcaseCases.updatedAt));

  return rows.map(({ case: item, artifact }) => toShowcaseCaseView(item, artifact));
}

export async function listPublishedShowcaseCases(): Promise<ShowcaseCaseView[]> {
  const database = getDatabase();
  const rows = await database
    .select({
      case: showcaseCases,
      artifact: showcaseArtifacts,
    })
    .from(showcaseCases)
    .innerJoin(
      showcaseArtifacts,
      and(
        eq(showcaseArtifacts.caseId, showcaseCases.id),
        eq(showcaseArtifacts.status, "active"),
      ),
    )
    .where(eq(showcaseCases.status, "published"))
    .orderBy(asc(showcaseCases.sortOrder), desc(showcaseCases.publishedAt));

  return rows.map(({ case: item, artifact }) => toShowcaseCaseView(item, artifact));
}

export async function getPublishedShowcaseCase(
  slug: string,
): Promise<ShowcaseCaseView | null> {
  const database = getDatabase();
  const [row] = await database
    .select({
      case: showcaseCases,
      artifact: showcaseArtifacts,
    })
    .from(showcaseCases)
    .innerJoin(
      showcaseArtifacts,
      and(
        eq(showcaseArtifacts.caseId, showcaseCases.id),
        eq(showcaseArtifacts.status, "active"),
      ),
    )
    .where(and(eq(showcaseCases.slug, slug), eq(showcaseCases.status, "published")))
    .limit(1);

  return row ? toShowcaseCaseView(row.case, row.artifact) : null;
}

/**
 * 每次发布都先把当前 active 版本标记为 revoked，再插入一个新的 artifact。
 * 文件写入使用不可变 prefix，旧版本不覆盖、不复用，便于回滚和审计。
 */
export async function publishShowcaseArtifact(
  input: ShowcasePublishInput,
): Promise<ShowcaseCaseView> {
  const token = requireBlobToken();
  const caseId = input.caseId ?? randomUUID();
  const artifactId = randomUUID();
  const blobPrefix = `showcase/${artifactId}`;
  const uploadedUrls: string[] = [];

  await validatePublishInput(input);

  try {
    for (const file of input.files) {
      const uploaded = await put(
        `${blobPrefix}/${normalizeArtifactPath(file.path)}`,
        // @vercel/blob 的 Node 运行时类型要求 Buffer；artifact 层仍保持
        // Uint8Array，避免把存储适配细节泄漏到 WebContainer 构建流程。
        Buffer.from(file.content),
        {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          token,
          contentType: contentTypeForPath(file.path),
          cacheControlMaxAge: 31536000,
        },
      );
      uploadedUrls.push(uploaded.url);
    }

    const manifestUpload = await put(
      `${blobPrefix}/webpilot-artifact.json`,
      `${JSON.stringify(input.manifest, null, 2)}\n`,
      {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        token,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 31536000,
      },
    );
    uploadedUrls.push(manifestUpload.url);

    const published = await runDatabaseTransaction(async (transaction) => {
      const [caseRow] = await transaction
        .insert(showcaseCases)
        .values({
          id: caseId,
          projectId: input.projectId ?? null,
          title: input.title,
          slug: input.slug,
          description: input.description ?? null,
          coverUrl: input.coverUrl ?? null,
          sortOrder: input.sortOrder ?? 0,
          status: "published",
          publishedAt: new Date(),
          revokedAt: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: showcaseCases.id,
          set: {
            projectId: input.projectId ?? null,
            title: input.title,
            slug: input.slug,
            description: input.description ?? null,
            coverUrl: input.coverUrl ?? null,
            sortOrder: input.sortOrder ?? 0,
            status: "published",
            publishedAt: new Date(),
            revokedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!caseRow) {
        throw new Error("创建 Showcase 案例失败。");
      }

      await transaction
        .update(showcaseArtifacts)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(
          and(
            eq(showcaseArtifacts.caseId, caseId),
            eq(showcaseArtifacts.status, "active"),
          ),
        );

      await transaction.insert(showcaseArtifacts).values({
        id: artifactId,
        caseId,
        sourceRevision: input.sourceRevision,
        status: "active",
        blobPrefix,
        entryPath: input.manifest.entryPath,
        manifest: input.manifest,
        fileCount: input.manifest.files.length,
        totalBytes: input.manifest.totalBytes,
      });

      const [created] = await transaction
        .select({ case: showcaseCases, artifact: showcaseArtifacts })
        .from(showcaseCases)
        .innerJoin(showcaseArtifacts, eq(showcaseArtifacts.id, artifactId))
        .where(eq(showcaseCases.id, caseId))
        .limit(1);

      return created;
    });

    if (!published) {
      throw new Error("读取刚发布的 Showcase 案例失败。");
    }

    return toShowcaseCaseView(published.case, published.artifact);
  } catch (error) {
    if (uploadedUrls.length > 0) {
      await del(uploadedUrls, { token }).catch((cleanupError) => {
        console.error("[showcase-cleanup]", cleanupError);
      });
    }
    throw error;
  }
}

export async function revokeShowcaseCase(caseId: string): Promise<void> {
  const database = getDatabase();
  const now = new Date();

  await database
    .update(showcaseCases)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(eq(showcaseCases.id, caseId));
  await database
    .update(showcaseArtifacts)
    .set({ status: "revoked", revokedAt: now })
    .where(
      and(eq(showcaseArtifacts.caseId, caseId), eq(showcaseArtifacts.status, "active")),
    );
}

/**
 * Runtime 先验证 artifact 仍属于已发布案例，再读取精确的 Blob pathname。
 * 即使调用方传入了看似合法的 Blob URL，也不会被转发到 Vercel Blob。
 */
export async function readPublishedArtifactFile(
  artifactId: string,
  rawPath: string,
): Promise<{
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  size: number;
  isEntry: boolean;
} | null> {
  const path = normalizeArtifactPath(rawPath);
  const database = getDatabase();
  const [row] = await database
    .select({
      artifact: showcaseArtifacts,
      caseStatus: showcaseCases.status,
    })
    .from(showcaseArtifacts)
    .innerJoin(showcaseCases, eq(showcaseCases.id, showcaseArtifacts.caseId))
    .where(
      and(
        eq(showcaseArtifacts.id, artifactId),
        eq(showcaseArtifacts.status, "active"),
        eq(showcaseCases.status, "published"),
        isNull(showcaseCases.revokedAt),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const manifest = row.artifact.manifest as ShowcaseArtifactManifest;
  const file = manifest.files.find((entry) => entry.path === path);
  if (!file) {
    return null;
  }

  const blob = await get(
    `${row.artifact.blobPrefix}/${path}`,
    {
      access: "private",
      token: requireBlobToken(),
      useCache: true,
    },
  );

  if (!blob || blob.statusCode !== 200) {
    return null;
  }

  return {
    stream: blob.stream,
    contentType: contentTypeForPath(path),
    size: file.byteLength,
    isEntry: path === row.artifact.entryPath,
  };
}

async function validatePublishInput(input: ShowcasePublishInput): Promise<void> {
  if (input.sourceRevision < 0 || !Number.isInteger(input.sourceRevision)) {
    throw new Error("sourceRevision 必须是非负整数。");
  }

  if (input.files.length !== input.manifest.files.length) {
    throw new Error("artifact 文件与 manifest 数量不一致。");
  }

  const manifestFiles = new Map<
    string,
    ShowcaseArtifactManifest["files"][number]
  >();
  let manifestTotalBytes = 0;

  for (const manifestFile of input.manifest.files) {
    const path = normalizeArtifactPath(manifestFile.path);
    if (manifestFiles.has(path)) {
      throw new Error(`manifest 中存在重复文件：${path}`);
    }

    manifestFiles.set(path, manifestFile);
    manifestTotalBytes += manifestFile.byteLength;
  }

  if (manifestTotalBytes !== input.manifest.totalBytes) {
    throw new Error("artifact manifest 的 totalBytes 不正确。");
  }

  let actualTotalBytes = 0;
  for (const file of input.files) {
    const path = normalizeArtifactPath(file.path);
    const manifestFile = manifestFiles.get(path);
    if (
      !manifestFile ||
      manifestFile.hash !== file.hash ||
      manifestFile.byteLength !== file.content.byteLength
    ) {
      throw new Error(`artifact 文件 hash 与 manifest 不一致：${path}`);
    }

    const actualHash = await sha256Hex(file.content);
    if (actualHash !== manifestFile.hash.toLowerCase()) {
      throw new Error(`artifact 文件内容 hash 校验失败：${path}`);
    }

    actualTotalBytes += file.content.byteLength;
  }

  if (actualTotalBytes !== input.manifest.totalBytes) {
    throw new Error("artifact 文件实际大小与 manifest 不一致。");
  }
}

function toShowcaseCaseView(
  item: ShowcaseCaseRow,
  artifact: ShowcaseArtifactManifestRow | null,
): ShowcaseCaseView {
  return {
    id: item.id,
    projectId: item.projectId,
    title: item.title,
    slug: item.slug,
    description: item.description,
    coverUrl: item.coverUrl,
    sortOrder: item.sortOrder,
    status: item.status,
    publishedAt: item.publishedAt?.toISOString() ?? null,
    artifact: artifact
      ? {
          id: artifact.id,
          sourceRevision: artifact.sourceRevision,
          entryPath: artifact.entryPath as "index.html",
          fileCount: artifact.fileCount,
          totalBytes: artifact.totalBytes,
          createdAt: artifact.createdAt.toISOString(),
        }
      : null,
  };
}

function requireBlobToken(): string {
  const token = serverEnv.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error("Showcase 需要配置 BLOB_READ_WRITE_TOKEN。");
  }
  return token;
}

function contentTypeForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "html":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
    case "cjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
