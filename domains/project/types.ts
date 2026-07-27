export type ProjectStorageKind = "database" | "browser_git";
export type ProjectStatus = "creating" | "ready" | "error";

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
  revision: number;
  summary: string | null;
  createdAt: string;
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
