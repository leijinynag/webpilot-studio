import { createHash } from "node:crypto";

import { IMAGE_ERROR_CODES, ImageError } from "@/domains/image/errors";

export const IMAGE_UPLOAD_LIMITS = {
  maxFilesPerRequest: 4,
  maxBytes: 10 * 1024 * 1024,
  maxWidth: 8_192,
  maxHeight: 8_192,
  maxPixels: 25_000_000,
} as const;

const MIME_TO_FORMAT = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
} as const;

type SupportedMime = keyof typeof MIME_TO_FORMAT;
type ImageFormat = (typeof MIME_TO_FORMAT)[SupportedMime];

export type ValidatedImage = {
  bytes: Uint8Array;
  mimeType: SupportedMime;
  format: ImageFormat;
  originalFilename: string;
  byteLength: number;
  sha256: string;
  width: number;
  height: number;
};

export type ValidatedGeneratedImage = Omit<
  ValidatedImage,
  "originalFilename"
> & {
  originalFilename: string;
};

/**
 * 只相信文件内容而不是浏览器传来的 MIME。
 *
 * MIME 是客户端可以任意填写的元数据，魔数和尺寸则从二进制头读取。两者
 * 必须同时匹配，避免把任意文件伪装成图片写入私有资产存储。
 */
export async function validateImageFile(file: File): Promise<ValidatedImage> {
  const mimeType = normalizeMimeType(file.type);
  const bytes = new Uint8Array(await file.arrayBuffer());

  return validateImageBytes({
    bytes,
    mimeType,
    originalFilename: file.name,
  });
}

/**
 * 生图 Provider 返回的内容没有浏览器 File 元数据，因此必须使用单独入口
 * 传入供应商声明的 MIME，并复用同一套大小、魔数和尺寸校验。
 *
 * Worker 只有拿到这个结构化结果后，才允许把二进制写入 Blob 和资产表。
 */
export function validateGeneratedImage(input: {
  bytes: Uint8Array;
  mimeType: string;
  originalFilename: string;
}): ValidatedGeneratedImage {
  return validateImageBytes({
    bytes: input.bytes,
    mimeType: normalizeMimeType(input.mimeType),
    originalFilename: input.originalFilename,
  });
}

function validateImageBytes(input: {
  bytes: Uint8Array;
  mimeType: SupportedMime | null;
  originalFilename: string;
}): ValidatedImage {
  const { bytes, mimeType } = input;

  if (!mimeType) {
    throw new ImageError(
      IMAGE_ERROR_CODES.unsupportedMime,
      "仅支持 PNG、JPEG 和 WebP 图片。",
    );
  }

  if (bytes.length === 0 || bytes.length > IMAGE_UPLOAD_LIMITS.maxBytes) {
    throw new ImageError(
      IMAGE_ERROR_CODES.fileTooLarge,
      `图片大小必须在 1 字节到 ${IMAGE_UPLOAD_LIMITS.maxBytes} 字节之间。`,
      413,
      { maxBytes: IMAGE_UPLOAD_LIMITS.maxBytes, byteLength: bytes.length },
    );
  }

  const format = MIME_TO_FORMAT[mimeType];
  if (!matchesMagic(bytes, format)) {
    throw new ImageError(
      IMAGE_ERROR_CODES.mimeMismatch,
      "图片 MIME 类型与文件内容不匹配。",
      415,
      { mimeType },
    );
  }

  const dimensions = readImageDimensions(bytes, format);
  if (
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > IMAGE_UPLOAD_LIMITS.maxWidth ||
    dimensions.height > IMAGE_UPLOAD_LIMITS.maxHeight ||
    dimensions.width * dimensions.height > IMAGE_UPLOAD_LIMITS.maxPixels
  ) {
    throw new ImageError(
      IMAGE_ERROR_CODES.invalidDimensions,
      "图片尺寸超过当前上传限制。",
      413,
      { ...dimensions, limits: IMAGE_UPLOAD_LIMITS },
    );
  }

  return {
    bytes,
    mimeType,
    format,
    originalFilename: sanitizeFilename(input.originalFilename),
    byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...dimensions,
  };
}

export function buildPrivateImagePathname(input: {
  ownerId: string;
  projectId: string;
  attachmentId: string;
  filename: string;
}): string {
  const extension = extensionForMime(filenameExtension(input.filename));
  return `private-assets/${input.ownerId}/${input.projectId}/${input.attachmentId}.${extension}`;
}

export function buildGeneratedImagePathname(input: {
  ownerId: string;
  projectId: string;
  imageRunId: string;
  generationIndex: number;
  format: ImageFormat;
}): string {
  return `private-assets/${input.ownerId}/${input.projectId}/generated/${input.imageRunId}/${input.generationIndex}.${input.format === "jpeg" ? "jpg" : input.format}`;
}

export function sanitizeFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

  return normalized || "uploaded-image";
}

function normalizeMimeType(value: string): SupportedMime | null {
  const normalized = value.trim().toLowerCase().split(";")[0];
  return normalized in MIME_TO_FORMAT ? (normalized as SupportedMime) : null;
}

function matchesMagic(bytes: Uint8Array, format: ImageFormat): boolean {
  if (format === "png") {
    return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }

  if (format === "jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }

  return (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
  );
}

function readImageDimensions(
  bytes: Uint8Array,
  format: ImageFormat,
): { width: number; height: number } {
  if (format === "png") {
    if (bytes.length < 24) {
      throw invalidMagic("PNG 文件头不完整。");
    }
    return {
      width: readUint32(bytes, 16),
      height: readUint32(bytes, 20),
    };
  }

  if (format === "webp") {
    return readWebpDimensions(bytes);
  }

  return readJpegDimensions(bytes);
}

function readWebpDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  if (bytes.length < 30) {
    throw invalidMagic("WebP 文件头不完整。");
  }

  const chunk = textAt(bytes, 12, 4);
  if (chunk === "VP8X") {
    return {
      width: 1 + readUint24(bytes, 24),
      height: 1 + readUint24(bytes, 27),
    };
  }

  if (chunk === "VP8 ") {
    const start = 20;
    const frame = findBytes(bytes, [0x9d, 0x01, 0x2a], start);
    if (frame === -1 || frame + 7 > bytes.length) {
      throw invalidMagic("WebP VP8 尺寸头不完整。");
    }
    return {
      width: readUint16(bytes, frame + 3) & 0x3fff,
      height: readUint16(bytes, frame + 5) & 0x3fff,
    };
  }

  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f || bytes.length < 25) {
      throw invalidMagic("WebP VP8L 尺寸头不完整。");
    }
    const bits =
      bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >>> 14) & 0x3fff),
    };
  }

  throw invalidMagic("不支持的 WebP 编码块。");
}

function readJpegDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
} {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    offset += 2;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }

    const segmentLength = readUint16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) {
      return {
        height: readUint16(bytes, offset + 3),
        width: readUint16(bytes, offset + 5),
      };
    }
    offset += segmentLength;
  }

  throw invalidMagic("JPEG 尺寸头不完整。");
}

function extensionForMime(value: string): string {
  return value === "jpg" || value === "jpeg" ? "jpg" : value || "bin";
}

function filenameExtension(value: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function findBytes(bytes: Uint8Array, needle: number[], start: number): number {
  outer: for (
    let index = start;
    index <= bytes.length - needle.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return index;
  }
  return -1;
}

function textAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function invalidMagic(message: string): ImageError {
  return new ImageError(IMAGE_ERROR_CODES.invalidMagic, message, 415);
}
