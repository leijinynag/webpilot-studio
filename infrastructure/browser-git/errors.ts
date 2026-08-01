import { PROJECT_ERROR_CODES, ProjectError } from "@/domains/project/errors";

export function browserGitError(
  code: ProjectError["code"],
  message: string,
  status = 409,
  details?: Record<string, unknown>,
) {
  return new ProjectError(code, message, status, details);
}

export function deserializeBrowserGitError(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}) {
  const codeMap: Record<string, ProjectError["code"]> = {
    INVALID_REQUEST: PROJECT_ERROR_CODES.invalidRequest,
    INVALID_PROJECT_PATH: PROJECT_ERROR_CODES.invalidPath,
    STORAGE_UNAVAILABLE: PROJECT_ERROR_CODES.storageUnavailable,
    PROJECT_REVISION_CONFLICT: PROJECT_ERROR_CODES.revisionConflict,
    FILE_NOT_FOUND: PROJECT_ERROR_CODES.fileNotFound,
    PROJECT_PATH_CONFLICT: PROJECT_ERROR_CODES.pathConflict,
    CHECKPOINT_NOT_FOUND: PROJECT_ERROR_CODES.checkpointNotFound,
    CHECKPOINT_QUOTA_EXCEEDED: PROJECT_ERROR_CODES.storageUnavailable,
    WORKER_UNAVAILABLE: PROJECT_ERROR_CODES.storageUnavailable,
  };
  const code = codeMap[error.code] ?? PROJECT_ERROR_CODES.storageUnavailable;
  const status =
    code === PROJECT_ERROR_CODES.fileNotFound ||
    code === PROJECT_ERROR_CODES.checkpointNotFound
      ? 404
      : code === PROJECT_ERROR_CODES.invalidRequest ||
          code === PROJECT_ERROR_CODES.invalidPath
        ? 400
        : 409;

  return new ProjectError(code, error.message, status, {
    ...error.details,
    // 保留 Worker 原始错误码，便于遥测区分配额、数据丢失与 Worker 中断。
    browserGitCode: error.code,
  });
}
