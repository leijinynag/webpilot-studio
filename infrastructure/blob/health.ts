import { randomUUID } from "node:crypto";

import { del, put } from "@vercel/blob";

export type BlobHealthResult = {
  provider: "vercel-blob";
  status: "ok";
  access: "private";
};

type UploadedBlob = {
  url: string;
  pathname: string;
};

export type BlobHealthDependencies = {
  upload: (pathname: string, body: string) => Promise<UploadedBlob>;
  remove: (url: string) => Promise<void>;
  createId?: () => string;
};

/**
 * Blob 验收必须真实覆盖“上传后删除”，但测试对象不能残留在正式资产命名空间。
 *
 * 删除放在 finally 中：上传成功后，即使返回值校验失败或后续逻辑抛错，也会尝试
 * 清理对象。这里不提供公开 Route Handler，避免匿名访客把健康检查变成写入接口。
 */
export async function verifyPrivateBlobReadWrite(
  dependencies: BlobHealthDependencies,
): Promise<BlobHealthResult> {
  const createId = dependencies.createId ?? randomUUID;
  const pathname = `health-checks/${createId()}.txt`;
  let uploadedUrl: string | null = null;

  try {
    const uploaded = await dependencies.upload(
      pathname,
      "webpilot-studio blob health check",
    );
    uploadedUrl = uploaded.url;

    if (uploaded.pathname !== pathname || !uploaded.url) {
      throw new Error("Vercel Blob 健康检查返回了非预期对象。");
    }

    return {
      provider: "vercel-blob",
      status: "ok",
      access: "private",
    };
  } finally {
    if (uploadedUrl) {
      await dependencies.remove(uploadedUrl);
    }
  }
}

export function checkPrivateBlobStorage(
  token: string,
): Promise<BlobHealthResult> {
  return verifyPrivateBlobReadWrite({
    upload: async (pathname, body) =>
      await put(pathname, body, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "text/plain; charset=utf-8",
        token,
      }),
    remove: async (url) => await del(url, { token }),
  });
}
