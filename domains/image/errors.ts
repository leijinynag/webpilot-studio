export const IMAGE_ERROR_CODES = {
  invalidRequest: "IMAGE_INVALID_REQUEST",
  uploadDisabled: "IMAGE_UPLOAD_DISABLED",
  blobNotConfigured: "IMAGE_BLOB_NOT_CONFIGURED",
  blobUnavailable: "IMAGE_BLOB_UNAVAILABLE",
  projectNotFound: "IMAGE_PROJECT_NOT_FOUND",
  conversationNotFound: "IMAGE_CONVERSATION_NOT_FOUND",
  attachmentNotFound: "IMAGE_ATTACHMENT_NOT_FOUND",
  assetNotFound: "IMAGE_ASSET_NOT_FOUND",
  fileRequired: "IMAGE_FILE_REQUIRED",
  tooManyFiles: "IMAGE_TOO_MANY_FILES",
  unsupportedMime: "IMAGE_UNSUPPORTED_MIME",
  mimeMismatch: "IMAGE_MIME_MISMATCH",
  invalidMagic: "IMAGE_INVALID_MAGIC",
  fileTooLarge: "IMAGE_FILE_TOO_LARGE",
  invalidDimensions: "IMAGE_INVALID_DIMENSIONS",
  storageWriteFailed: "IMAGE_STORAGE_WRITE_FAILED",
  storageDeleteFailed: "IMAGE_STORAGE_DELETE_FAILED",
  assetDeleteFailed: "IMAGE_ASSET_DELETE_FAILED",
  visionNotConfigured: "IMAGE_VISION_NOT_CONFIGURED",
  visionTimeout: "IMAGE_VISION_TIMEOUT",
  visionUnsupportedFormat: "IMAGE_VISION_UNSUPPORTED_FORMAT",
  visionContentRejected: "IMAGE_VISION_CONTENT_REJECTED",
  visionInvalidResponse: "IMAGE_VISION_INVALID_RESPONSE",
  generationNotConfigured: "IMAGE_GENERATION_NOT_CONFIGURED",
  generationTimeout: "IMAGE_GENERATION_TIMEOUT",
  generationContentRejected: "IMAGE_GENERATION_CONTENT_REJECTED",
  generationInvalidResponse: "IMAGE_GENERATION_INVALID_RESPONSE",
  generationFailed: "IMAGE_GENERATION_FAILED",
  generationJobNotFound: "IMAGE_GENERATION_JOB_NOT_FOUND",
} as const;

export type ImageErrorCode =
  (typeof IMAGE_ERROR_CODES)[keyof typeof IMAGE_ERROR_CODES];

export class ImageError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ImageError";
  }
}

export function isImageError(error: unknown): error is ImageError {
  return error instanceof ImageError;
}
