export const PROJECT_ERROR_CODES = {
  invalidRequest: "INVALID_REQUEST",
  invalidPath: "INVALID_PROJECT_PATH",
  projectNotFound: "PROJECT_NOT_FOUND",
  projectDeleted: "PROJECT_DELETED",
  fileNotFound: "FILE_NOT_FOUND",
  pathConflict: "PROJECT_PATH_CONFLICT",
  revisionConflict: "PROJECT_REVISION_CONFLICT",
  storageUnavailable: "STORAGE_KIND_UNAVAILABLE",
  originRejected: "ORIGIN_REJECTED",
} as const;

export type ProjectErrorCode =
  (typeof PROJECT_ERROR_CODES)[keyof typeof PROJECT_ERROR_CODES];

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export function isProjectError(error: unknown): error is ProjectError {
  return error instanceof ProjectError;
}
