import type {
  ProjectCheckpoint,
  ProjectDescription,
  ProjectFileMutation,
  ProjectFileSnapshot,
  ProjectMutationResult,
  ProjectSearchMatch,
  ProjectStorageKind,
} from "@/domains/project/types";

/**
 * Worker 与主线程之间只传递可结构化克隆的数据。
 * 将协议独立出来，可以让页面、Repository adapter 和 Worker 各自演进，
 * 同时避免把 LightningFS 或 isomorphic-git 的对象泄漏到 React 层。
 */
export type BrowserGitFileInput = {
  path: string;
  content: string;
};

export type BrowserGitFileStatus =
  "added" | "modified" | "deleted" | "untracked";

export type BrowserGitChangedFile = {
  path: string;
  status: BrowserGitFileStatus;
  staged: boolean;
  unstaged: boolean;
  oldContent: string | null;
  stagedContent: string | null;
  newContent: string | null;
  additions: number;
  deletions: number;
};

export type BrowserGitCommit = {
  oid: string;
  message: string;
  author: {
    name: string;
    email: string;
    timestamp: number;
  };
  committer: {
    name: string;
    email: string;
    timestamp: number;
  };
  parent: string | null;
};

export type BrowserGitRepositoryState = {
  projectId: string;
  revision: number;
  branch: string;
  head: string | null;
  ahead: number;
  behind: number;
  files: BrowserGitChangedFile[];
  commits: BrowserGitCommit[];
  unavailable: boolean;
  unavailableReason: string | null;
};

export type BrowserGitCheckpointRecord = {
  id: string;
  projectId: string;
  revision: number;
  summary: string | null;
  manifest: BrowserGitFileInput[];
  head: string | null;
  indexHash: string;
  branch: string;
  createdAt: string;
  completedAt: string | null;
};

export type BrowserGitMigrationValidation = {
  repositoryId: string;
  revision: number;
  head: string;
  branch: "main";
  clean: true;
  manifestHash: string;
  fileCount: number;
};

export type BrowserGitWorkerPayloadMap = {
  initialize: {
    projectId: string;
    projectName: string;
    initialFiles: BrowserGitFileInput[];
    /**
     * 只有服务端项目索引成功消费首次 provision claim 后才允许创建仓库。
     * 后续恢复固定传 false，避免站点数据丢失时静默生成一个同 ID 的空仓库。
     */
    allowCreate: boolean;
  };
  state: Record<string, never>;
  list_files: Record<string, never>;
  read_file: { path: string };
  search_text: {
    query: string;
    maxResults: number;
    maxExcerptCharacters: number;
    maxTotalCharacters: number;
  };
  write_file: {
    path: string;
    content: string;
    expectedRevision: number;
  };
  delete_file: { path: string; expectedRevision: number };
  rename_file: {
    fromPath: string;
    toPath: string;
    expectedRevision: number;
  };
  batch_mutate_files: {
    expectedRevision: number;
    mutations: ProjectFileMutation[];
  };
  stage: { paths: string[] };
  unstage: { paths: string[] };
  commit: {
    message: string;
    authorName: string;
    authorEmail: string;
  };
  export: Record<string, never>;
  create_checkpoint: {
    summary?: string;
    expectedRevision?: number;
  };
  restore_checkpoint: {
    checkpointId: string;
    expectedRevision: number;
  };
  initialize_migration_candidate: {
    projectName: string;
    sourceRevision: number;
    manifestHash: string;
    initialFiles: BrowserGitFileInput[];
  };
  validate_migration_candidate: {
    sourceRevision: number;
    manifestHash: string;
  };
  promote_migration_candidate: {
    targetProjectId: string;
    projectName: string;
    sourceRevision: number;
    manifestHash: string;
    head: string;
  };
  delete_repository: Record<string, never>;
};

export type BrowserGitWorkerOperation = keyof BrowserGitWorkerPayloadMap;

export type BrowserGitWorkerRequest<
  TOperation extends BrowserGitWorkerOperation = BrowserGitWorkerOperation,
> = {
  protocol: "webpilot.browser-git.v1";
  type: "request";
  requestId: string;
  projectId: string;
  operation: TOperation;
  payload: BrowserGitWorkerPayloadMap[TOperation];
};

export type BrowserGitWorkerResult = {
  protocol: "webpilot.browser-git.v1";
  type: "result";
  requestId: string;
  projectId: string;
  operation: BrowserGitWorkerOperation;
  revision: number;
  data:
    | BrowserGitRepositoryState
    | ProjectFileSnapshot[]
    | ProjectFileSnapshot
    | ProjectSearchMatch[]
    | ProjectMutationResult
    | ProjectCheckpoint
    | BrowserGitCheckpointRecord
    | BrowserGitMigrationValidation
    | { oid: string; state: BrowserGitRepositoryState }
    | { archive: string; fileCount: number };
};

export type BrowserGitWorkerError = {
  protocol: "webpilot.browser-git.v1";
  type: "error";
  requestId: string;
  projectId: string;
  operation: BrowserGitWorkerOperation;
  error: {
    code:
      | "INVALID_REQUEST"
      | "STORAGE_UNAVAILABLE"
      | "PROJECT_REVISION_CONFLICT"
      | "FILE_NOT_FOUND"
      | "PROJECT_PATH_CONFLICT"
      | "INVALID_PROJECT_PATH"
      | "CHECKPOINT_NOT_FOUND"
      | "CHECKPOINT_QUOTA_EXCEEDED"
      | "WORKER_UNAVAILABLE";
    message: string;
    details?: Record<string, unknown>;
  };
};

export type BrowserGitWorkerResponse =
  BrowserGitWorkerResult | BrowserGitWorkerError;

export type BrowserGitProjectDescription = ProjectDescription & {
  storageKind: Extract<ProjectStorageKind, "browser_git">;
};
