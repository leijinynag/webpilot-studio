import type { ProjectContentRepository } from "@/tests/contract/project-repository-contract";
import {
  describeProjectContentRepositoryContract,
  describeProjectIndexRepositoryContract,
} from "@/tests/contract/project-repository-contract";
import { DatabaseProjectRepository } from "@/domains/project/repository";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

describeProjectContentRepositoryContract("Database", async () => {
  const testDatabase = await createTestDatabase();
  const repository = new DatabaseProjectRepository(testDatabase.database);
  const ownerId = "content-owner";
  let projectId: string | null = null;

  const contentRepository: ProjectContentRepository = {
    async initialize(initialFiles) {
      const project = await repository.createProject({
        ownerId,
        name: "Content contract",
        initialFiles,
      });
      projectId = project.id;
      return { revision: project.revision, fileCount: project.fileCount };
    },
    async getRevision() {
      const project = await repository.describe({
        ownerId,
        projectId: requireProjectId(projectId),
      });
      return project.revision;
    },
    listFiles: () =>
      repository.listFiles({
        ownerId,
        projectId: requireProjectId(projectId),
      }),
    readFile: (path) =>
      repository.readFile({
        ownerId,
        projectId: requireProjectId(projectId),
        path,
      }),
    searchText: (query, options) =>
      repository.searchText({
        ownerId,
        projectId: requireProjectId(projectId),
        query,
        options,
      }),
    writeFile: (input) =>
      repository.writeFile({
        ownerId,
        projectId: requireProjectId(projectId),
        ...input,
      }),
    deleteFile: (input) =>
      repository.deleteFile({
        ownerId,
        projectId: requireProjectId(projectId),
        ...input,
      }),
    renameFile: (input) =>
      repository.renameFile({
        ownerId,
        projectId: requireProjectId(projectId),
        ...input,
      }),
    batchMutateFiles: (input) =>
      repository.batchMutateFiles({
        ownerId,
        projectId: requireProjectId(projectId),
        ...input,
      }),
    createCheckpoint: (input) =>
      repository.createCheckpoint({
        ownerId,
        projectId: requireProjectId(projectId),
        ...input,
      }),
    restoreCheckpoint: (input) =>
      repository.restoreCheckpoint({
        ownerId,
        projectId: requireProjectId(projectId),
        ...input,
      }),
  };

  return {
    repository: contentRepository,
    close: testDatabase.close,
  };
});

describeProjectIndexRepositoryContract(async () => {
  const testDatabase = await createTestDatabase();

  return {
    repository: new DatabaseProjectRepository(testDatabase.database),
    close: testDatabase.close,
  };
});

function requireProjectId(projectId: string | null) {
  if (!projectId) {
    throw new Error("测试项目尚未初始化。");
  }
  return projectId;
}
