import "server-only";

import { del, get, put } from "@vercel/blob";

import {
  IMAGE_ERROR_CODES,
  ImageError,
} from "@/domains/image/errors";
import { serverEnv } from "@/infrastructure/env/server";

export type PrivateBlobObject = {
  url: string;
  pathname: string;
};

export type PrivateBlobStore = {
  put(
    pathname: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<PrivateBlobObject>;
  get(pathname: string): Promise<{
    stream: ReadableStream<Uint8Array>;
    contentType: string | null;
    size: number | null;
  } | null>;
  del(pathname: string): Promise<void>;
};

/**
 * 私有 Blob 的唯一出口。
 *
 * 业务层只传 pathname，不接受客户端传来的 Blob URL。这样即使数据库中的
 * URL 被误返回，也不会让调用方借助任意 URL 读取另一个 owner 的对象。
 */
export function getPrivateBlobStore(): PrivateBlobStore {
  const token = serverEnv.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new ImageError(
      IMAGE_ERROR_CODES.blobNotConfigured,
      "图片存储尚未配置 BLOB_READ_WRITE_TOKEN。",
      503,
    );
  }

  return {
    async put(pathname, body, contentType) {
      try {
        return await put(
          pathname,
          typeof body === "string" ? body : Buffer.from(body),
          {
            access: "private",
            addRandomSuffix: false,
            allowOverwrite: false,
            contentType,
            token,
          },
        );
      } catch (error) {
        throw new ImageError(
          IMAGE_ERROR_CODES.storageWriteFailed,
          "图片写入私有存储失败。",
          503,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
    async get(pathname) {
      try {
        const result = await get(pathname, {
          access: "private",
          token,
          useCache: true,
        });
        if (!result || result.statusCode !== 200) {
          return null;
        }
        return {
          stream: result.stream,
          contentType: result.headers.get("content-type"),
          size: parseContentLength(result.headers.get("content-length")),
        };
      } catch (error) {
        throw new ImageError(
          IMAGE_ERROR_CODES.blobUnavailable,
          "图片读取私有存储失败。",
          503,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
    async del(pathname) {
      try {
        await del(pathname, { token });
      } catch (error) {
        throw new ImageError(
          IMAGE_ERROR_CODES.storageDeleteFailed,
          "图片私有存储清理失败。",
          503,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}

function parseContentLength(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}
