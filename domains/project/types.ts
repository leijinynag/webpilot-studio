export type ProjectStorageKind = "database" | "browser_git";
export type ProjectStatus = "creating" | "ready" | "unavailable" | "error";

export type ProjectSummary = {
  id: string;
  name: string;
  storageKind: ProjectStorageKind;
  status: ProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type ProjectDescription = ProjectSummary & {
  fileCount: number;
};

export type ProjectFileSnapshot = {
  path: string;
  content: string;
  byteLength: number;
  hash: string;
  updatedAt: string;
};

export type ProjectMutationResult = {
  revision: number;
  changedPaths: string[];
};

export type ProjectCheckpoint = {
  id: string;
  projectId: string;
  runId: string | null;
  kind: "revision" | "agent_start" | "agent_success" | "restore";
  revision: number;
  summary: string | null;
  createdAt: string;
};

export type ProjectChangeOperation = "create" | "update" | "delete" | "rename";

export type ProjectRevisionManifestEntry = {
  path: string;
  hash: string;
};

export type ProjectChangeSetFile = {
  id: string;
  operation: ProjectChangeOperation;
  pathBefore: string | null;
  pathAfter: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  sortOrder: number;
};

export type ProjectChangeSet = {
  id: string;
  projectId: string;
  runId: string;
  baseCheckpointId: string;
  resultCheckpointId: string;
  baseRevision: number;
  resultRevision: number;
  summary: string;
  files: ProjectChangeSetFile[];
  createdAt: string;
};

export type ProjectRestoreImpact = {
  path: string;
  currentHash: string | null;
  resultHash: string | null;
  restoreHash: string | null;
  action: "write" | "delete" | "none";
};

export type ProjectRestoreConflict = {
  path: string;
  currentHash: string | null;
  resultHash: string | null;
  restoreHash: string | null;
  reason: "modified" | "created" | "deleted";
};

export type ProjectRestorePreview = {
  runId: string;
  changeSetId: string;
  currentRevision: number;
  impacts: ProjectRestoreImpact[];
  conflicts: ProjectRestoreConflict[];
  canRestore: boolean;
};

export type ProjectRestoreResult = ProjectMutationResult & {
  checkpoint: ProjectCheckpoint;
};

export type ProjectSearchMatch = {
  path: string;
  line: number;
  column: number;
  excerpt: string;
};

export type ProjectSearchOptions = {
  maxResults?: number;
  maxExcerptCharacters?: number;
  maxTotalCharacters?: number;
};
