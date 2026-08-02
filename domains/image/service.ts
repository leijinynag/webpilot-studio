import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, ne, or } from "drizzle-orm";

import {
  IMAGE_ERROR_CODES,
  ImageError,
} from "@/domains/image/errors";
import {
  buildPrivateImagePathname,
  validateImageFile,
  IMAGE_UPLOAD_LIMITS,
} from "@/domains/image/validation";
import {
  chatAttachments,
  conversations,
  projectAssets,
  projects,
} from "@/infrastructure/db/schema";
import { getDatabase, runDatabaseTransaction } from "@/infrastructure/db/client";
import { getPrivateBlobStore } from "@/infrastructure/blob/private-store";
import { serverEnv } from "@/infrastructure/env/server";

export function assertAttachmentUploadEnabled(): void {
  if (serverEnv.ATTACHMENT_UPLOAD_ENABLED !== "true") {
    throw new ImageError(
      IMAGE_ERROR_CODES.uploadDisabled,
      "图片附件上传功能尚未启用。",
      503,
    );
  }
}

export async function assertOwnedProject(input: {
  ownerId: string;
  projectId: string;
}) {
  const [project] = await getDatabase()
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .where(
      and(
        eq(projects.id, input.projectId),
        eq(projects.ownerId, input.ownerId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);

  if (!project) {
    throw new ImageError(
      IMAGE_ERROR_CODES.projectNotFound,
      "项目不存在或不属于当前匿名工作区。",
      404,
    );
  }

  return project;
}

export async function assertOwnedConversation(input: {
  ownerId: string;
  projectId: string;
  conversationId: string;
}) {
  const [conversation] = await getDatabase()
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.projectId, input.projectId),
        eq(conversations.ownerId, input.ownerId),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);

  if (!conversation) {
    throw new ImageError(
      IMAGE_ERROR_CODES.conversationNotFound,
      "会话不存在或不属于当前项目。",
      404,
    );
  }
}

export async function createImageAttachments(input: {
  ownerId: string;
  projectId: string;
  conversationId?: string;
  files: File[];
}) {
  if (input.files.length === 0) {
    throw new ImageError(IMAGE_ERROR_CODES.fileRequired, "至少上传一张图片。");
  }
  if (input.files.length > IMAGE_UPLOAD_LIMITS.maxFilesPerRequest) {
    throw new ImageError(
      IMAGE_ERROR_CODES.tooManyFiles,
      `一次最多上传 ${IMAGE_UPLOAD_LIMITS.maxFilesPerRequest} 张图片。`,
    );
  }

  await assertOwnedProject(input);
  if (input.conversationId) {
    await assertOwnedConversation({
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
    });
  }

  const validated = await Promise.all(input.files.map(validateImageFile));
  const store = getPrivateBlobStore();
  const created: typeof chatAttachments.$inferSelect[] = [];
  // Blob 与数据库无法共享同一事务，因此只记录“尚未落库”的对象。
  // 已成功写入数据库的对象即使后续文件失败，也必须保留。
  const pendingPathnames = new Set<string>();

  try {
    for (const image of validated) {
      const attachmentId = randomUUID();
      const pathname = buildPrivateImagePathname({
        ownerId: input.ownerId,
        projectId: input.projectId,
        attachmentId,
        filename: `${image.originalFilename}.${image.format === "jpeg" ? "jpg" : image.format}`,
      });
      const blob = await store.put(
        pathname,
        image.bytes,
        image.mimeType,
      );
      pendingPathnames.add(pathname);

      const result = await runDatabaseTransaction(async (transaction) => {
        const [attachment] = await transaction
          .insert(chatAttachments)
          .values({
            id: attachmentId,
            ownerId: input.ownerId,
            projectId: input.projectId,
            conversationId: input.conversationId ?? null,
            originalFilename: image.originalFilename,
            mimeType: image.mimeType,
            byteLength: image.byteLength,
            sha256: image.sha256,
            blobPathname: blob.pathname,
            blobUrl: blob.url,
            width: image.width,
            height: image.height,
            status: "ready",
          })
          .returning();

        if (!attachment) {
          throw new ImageError(
            IMAGE_ERROR_CODES.storageWriteFailed,
            "图片附件记录创建失败。",
            503,
          );
        }

        // 项目资产按内容摘要幂等。重复上传仍然保留聊天附件，但不会在
        // 资产库里制造第二份逻辑资产，后续 UI 可以稳定引用同一个 assetId。
        await transaction
          .insert(projectAssets)
          .values({
            ownerId: input.ownerId,
            projectId: input.projectId,
            attachmentId: attachment.id,
            kind: "uploaded_image",
            source: "attachment",
            originalFilename: image.originalFilename,
            mimeType: image.mimeType,
            byteLength: image.byteLength,
            sha256: image.sha256,
            blobPathname: blob.pathname,
            blobUrl: blob.url,
            width: image.width,
            height: image.height,
            metadata: {
              uploadedFrom: "chat",
              conversationId: input.conversationId ?? null,
            },
          })
          .onConflictDoNothing();

        const [asset] = await transaction
          .select()
          .from(projectAssets)
          .where(
            and(
              eq(projectAssets.ownerId, input.ownerId),
              eq(projectAssets.projectId, input.projectId),
              eq(projectAssets.sha256, image.sha256),
              isNull(projectAssets.deletedAt),
            ),
          )
          .limit(1);

        return { attachment, asset: asset ?? null };
      });

      created.push(result.attachment);
      pendingPathnames.delete(pathname);

      // 如果相同内容已经存在资产库，当前附件仍然可独立删除；但不能把
      // 新上传的 Blob 留成孤儿对象。资产库已有对象时，新附件会复用其路径。
      if (result.asset && result.asset.blobPathname !== blob.pathname) {
        await store.del(blob.pathname);
        await getDatabase()
          .update(chatAttachments)
          .set({
            blobPathname: result.asset.blobPathname,
            blobUrl: result.asset.blobUrl,
            updatedAt: new Date(),
          })
          .where(eq(chatAttachments.id, result.attachment.id));
      }
    }

    return created.map(toAttachmentView);
  } catch (error) {
    await Promise.all(
      [...pendingPathnames].map((pathname) =>
        store.del(pathname).catch((cleanupError) => {
          console.error("[image-attachment-cleanup]", cleanupError);
        }),
      ),
    );
    throw error;
  }
}

export async function listOwnedAttachments(input: {
  ownerId: string;
  projectId: string;
  conversationId?: string;
}) {
  await assertOwnedProject(input);
  const rows = await getDatabase()
    .select()
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.ownerId, input.ownerId),
        eq(chatAttachments.projectId, input.projectId),
        input.conversationId
          ? or(
              isNull(chatAttachments.conversationId),
              eq(chatAttachments.conversationId, input.conversationId),
            )
          : undefined,
        isNull(chatAttachments.deletedAt),
      ),
    )
    .orderBy(desc(chatAttachments.createdAt));
  return rows.map(toAttachmentView);
}

export async function getOwnedAttachment(input: {
  ownerId: string;
  attachmentId: string;
}) {
  const [row] = await getDatabase()
    .select()
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.id, input.attachmentId),
        eq(chatAttachments.ownerId, input.ownerId),
        isNull(chatAttachments.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ImageError(
      IMAGE_ERROR_CODES.attachmentNotFound,
      "图片附件不存在或不属于当前匿名工作区。",
      404,
    );
  }
  return row;
}

/**
 * Vision 只通过 owner/project 约束读取附件。这里返回二进制而不是 Blob URL，
 * 让上层 Provider 无法绕过私有存储边界直接访问任意对象。
 */
export async function getOwnedAttachmentImage(input: {
  ownerId: string;
  projectId: string;
  conversationId?: string;
  attachmentId: string;
}) {
  await assertOwnedProject(input);
  if (input.conversationId) {
    await assertOwnedConversation({
      ownerId: input.ownerId,
      projectId: input.projectId,
      conversationId: input.conversationId,
    });
  }

  const [row] = await getDatabase()
    .select()
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.id, input.attachmentId),
        eq(chatAttachments.ownerId, input.ownerId),
        eq(chatAttachments.projectId, input.projectId),
        input.conversationId
          ? or(
              isNull(chatAttachments.conversationId),
              eq(chatAttachments.conversationId, input.conversationId),
            )
          : undefined,
        isNull(chatAttachments.deletedAt),
        eq(chatAttachments.status, "ready"),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ImageError(
      IMAGE_ERROR_CODES.attachmentNotFound,
      "图片附件不存在、已删除或不属于当前项目。",
      404,
    );
  }

  if (
    row.mimeType !== "image/png" &&
    row.mimeType !== "image/jpeg" &&
    row.mimeType !== "image/webp"
  ) {
    throw new ImageError(
      IMAGE_ERROR_CODES.visionUnsupportedFormat,
      "当前附件格式不能交给 Vision Provider。",
      415,
      { mimeType: row.mimeType },
    );
  }

  const blob = await getPrivateBlobStore().get(row.blobPathname);
  if (!blob) {
    throw new ImageError(
      IMAGE_ERROR_CODES.blobUnavailable,
      "图片对象不存在或尚未完成写入。",
      404,
    );
  }

  return {
    attachmentId: row.id,
    filename: row.originalFilename,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    bytes: await readBlobStream(blob.stream, IMAGE_UPLOAD_LIMITS.maxBytes),
  } as const;
}

export async function softDeleteAttachment(input: {
  ownerId: string;
  attachmentId: string;
}) {
  const row = await getOwnedAttachment(input);
  const now = new Date();
  await getDatabase()
    .update(chatAttachments)
    .set({ status: "deleted", deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(chatAttachments.id, row.id),
        eq(chatAttachments.ownerId, input.ownerId),
        isNull(chatAttachments.deletedAt),
      ),
    );
  try {
    await deleteBlobIfUnreferenced({
      pathname: row.blobPathname,
      excludedAttachmentId: row.id,
    });
  } catch (error) {
    console.error("[image-attachment-delete]", error);
  }
}

export async function listOwnedAssets(input: {
  ownerId: string;
  projectId: string;
}) {
  const rows = await listOwnedAssetRows(input);
  return rows.map(toAssetView);
}

/**
 * Agent 资产工具需要保留 ownerId 和原始 Date，才能在服务端生成绑定
 * owner/project 的临时 URL。这个内部查询不把数据库 Blob URL 暴露给调用方。
 */
export async function listOwnedAssetRows(input: {
  ownerId: string;
  projectId: string;
}) {
  await assertOwnedProject(input);
  const rows = await getDatabase()
    .select()
    .from(projectAssets)
    .where(
      and(
        eq(projectAssets.ownerId, input.ownerId),
        eq(projectAssets.projectId, input.projectId),
        isNull(projectAssets.deletedAt),
      ),
    )
    .orderBy(desc(projectAssets.createdAt));
  return rows;
}

export async function getOwnedAsset(input: {
  ownerId: string;
  assetId: string;
}) {
  const [row] = await getDatabase()
    .select()
    .from(projectAssets)
    .where(
      and(
        eq(projectAssets.id, input.assetId),
        eq(projectAssets.ownerId, input.ownerId),
        isNull(projectAssets.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ImageError(
      IMAGE_ERROR_CODES.assetNotFound,
      "项目资产不存在或不属于当前匿名工作区。",
      404,
    );
  }
  return row;
}

/**
 * 受控资产 URL 只需要 assetId 和 projectId 找到数据库事实，ownerId 由
 * 记录本身参与签名。这个查询不对外暴露，用于 Preview 的跨 origin 访问。
 */
export async function getActiveAssetForSignedAccess(input: {
  assetId: string;
  projectId: string;
}) {
  const [row] = await getDatabase()
    .select()
    .from(projectAssets)
    .where(
      and(
        eq(projectAssets.id, input.assetId),
        eq(projectAssets.projectId, input.projectId),
        isNull(projectAssets.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ImageError(
      IMAGE_ERROR_CODES.assetNotFound,
      "资产不存在或访问链接无效。",
      404,
    );
  }

  return row;
}

export async function softDeleteAsset(input: {
  ownerId: string;
  assetId: string;
}) {
  const row = await getOwnedAsset(input);
  const now = new Date();

  await getDatabase()
    .update(projectAssets)
    .set({ deletedAt: now })
    .where(
      and(
        eq(projectAssets.id, row.id),
        eq(projectAssets.ownerId, input.ownerId),
        isNull(projectAssets.deletedAt),
      ),
    );

  try {
    await deleteBlobIfUnreferenced({ pathname: row.blobPathname });
  } catch (error) {
    // 资产记录已经完成软删除。Blob 清理失败不会把用户的删除请求变成
    // 不确定状态，后续可由定时清理任务依据 deletedAt 再次回收。
    console.error("[image-asset-delete]", error);
  }
}

async function deleteBlobIfUnreferenced(input: {
  pathname: string;
  excludedAttachmentId?: string;
}) {
  const [activeAttachment] = await getDatabase()
    .select({ id: chatAttachments.id })
    .from(chatAttachments)
    .where(
      and(
        eq(chatAttachments.blobPathname, input.pathname),
        isNull(chatAttachments.deletedAt),
        input.excludedAttachmentId
          ? ne(chatAttachments.id, input.excludedAttachmentId)
          : undefined,
      ),
    )
    .limit(1);

  const [activeAsset] = await getDatabase()
    .select({ id: projectAssets.id })
    .from(projectAssets)
    .where(
      and(
        eq(projectAssets.blobPathname, input.pathname),
        isNull(projectAssets.deletedAt),
      ),
    )
    .limit(1);

  if (activeAttachment || activeAsset) {
    return;
  }

  await getPrivateBlobStore().del(input.pathname);
}

function toAttachmentView(row: typeof chatAttachments.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    conversationId: row.conversationId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAssetView(row: typeof projectAssets.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    source: row.source,
    attachmentId: row.attachmentId,
    imageRunId: row.imageRunId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAssetToolView(row: typeof projectAssets.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    source: row.source,
    attachmentId: row.attachmentId,
    imageRunId: row.imageRunId,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readBlobStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new ImageError(
          IMAGE_ERROR_CODES.fileTooLarge,
          "图片读取结果超过当前大小限制。",
          413,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
