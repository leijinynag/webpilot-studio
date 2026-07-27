import { DatabaseProjectRepository } from "@/domains/project/repository";
import { describeProjectRepositoryContract } from "@/tests/contract/project-repository-contract";
import { createTestDatabase } from "@/tests/database/helpers/pglite-database";

describeProjectRepositoryContract("Database", async () => {
  const testDatabase = await createTestDatabase();

  return {
    repository: new DatabaseProjectRepository(testDatabase.database),
    close: testDatabase.close,
  };
});
