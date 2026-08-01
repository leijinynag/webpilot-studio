import { expect, test, type Page } from "@playwright/test";

type Project = {
  id: string;
  revision: number;
  storageKind: "database" | "browser_git";
};

async function createProject(
  page: Page,
  input: {
    name: string;
    storageKind: Project["storageKind"];
    template: "empty" | "rsbuild";
  },
): Promise<Project> {
  // 先建立匿名会话，保证 request 创建的项目和后续页面使用同一个 owner。
  await page.goto("/");
  const response = await page.request.post("/api/projects", {
    data: input,
  });

  expect(response.status()).toBe(201);
  return ((await response.json()) as { project: Project }).project;
}

async function waitForBrowserRepository(page: Page) {
  await expect(
    page.getByText("正在恢复浏览器仓库。源码和 Git 状态准备完成后才会显示。"),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByLabel("Explorer")).toBeVisible({
    timeout: 15_000,
  });
}

async function deleteBrowserGitDatabase(page: Page, projectId: string) {
  // 页面离开工作台后，旧 Worker 会随页面生命周期结束，避免 IndexedDB 删除长期处于
  // blocked 状态；产品代码本身仍不会因为数据库消失而自动创建空仓库。
  await page.goto("/");
  await page.evaluate(
    (databaseName) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () =>
          reject(request.error ?? new Error("IndexedDB 删除失败。"));
        request.onblocked = () =>
          reject(new Error("IndexedDB 删除被仍在运行的 Worker 阻塞。"));
      }),
    `webpilot-browser-git-${projectId}`,
  );
}

test.describe("Browser Git M7 Gate", () => {
  test("creates an empty repository, commits through Source Control, and restores history after reload", async ({
    page,
  }) => {
    await page.goto("/new");
    await page.getByLabel("Project name").fill("E2E Browser Git persistence");
    await page.getByRole("button", { name: /Browser Git/ }).click();
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/);
    await waitForBrowserRepository(page);

    // 空项目不预置示例源码；第一份文件由工作台操作创建，验证“写完再准备依赖”的
    // 空仓库语义也没有被 Source Control 初始化流程破坏。
    await page.getByRole("button", { name: "新建文件" }).click();
    await page.getByLabel("文件路径").fill("src/index.tsx");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect(page.getByText("已创建 src/index.tsx", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: /Source Control/ }).click();
    await expect(page).toHaveURL(/\/source-control$/);
    await expect(
      page.getByRole("button", { name: "暂存 src/index.tsx" }),
    ).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: "暂存 src/index.tsx" }).click();
    await expect(
      page.getByRole("button", { name: "取消暂存 src/index.tsx" }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Describe this change..." })
      .fill("Add first Browser Git file");
    await page.getByLabel("Author").fill("M7 E2E");
    await page.getByLabel("Email").fill("m7-e2e@example.test");
    await page.getByRole("button", { name: "Commit staged changes" }).click();

    await expect(page.getByText("Working tree clean", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Add first Browser Git file" }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByText("Working tree clean", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Add first Browser Git file" }),
    ).toBeVisible();
    await expect(page.getByText("M7 E2E <m7-e2e@example.test>")).toBeVisible();
  });

  test("shows an explicit unavailable state after the Browser Git database is deleted", async ({
    page,
  }) => {
    const project = await createProject(page, {
      name: "E2E missing Browser Git repository",
      storageKind: "browser_git",
      template: "empty",
    });

    await page.goto(`/p/${project.id}`);
    await waitForBrowserRepository(page);
    await deleteBrowserGitDatabase(page, project.id);

    await page.goto(`/p/${project.id}`);
    await expect(
      page.getByText("本地 Browser Git 仓库不可用", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("不会自动创建空仓库覆盖原项目", { exact: false }),
    ).toBeVisible();

    await page.getByRole("link", { name: /Source Control/ }).click();
    await expect(
      page.getByRole("heading", { name: "本地仓库不可用", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("不会自动创建空仓库覆盖原项目", { exact: false }),
    ).toBeVisible();
  });

  test("migrates a Database project into Browser Git without losing the source snapshot", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const project = await createProject(page, {
      name: "E2E Database migration",
      storageKind: "database",
      template: "rsbuild",
    });

    await page.goto(`/p/${project.id}`);
    await expect(page.getByText("src/index.tsx", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Migrate" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "开始迁移", exact: true }).click();

    await expect(page.getByText("迁移完成", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText("工作台正在切换到当前浏览器中的 Browser Git 仓库。"),
    ).toBeVisible();

    // router.refresh 后服务端 storageKind 已切换；Source Control 再从同一 projectId
    // 打开正式 IndexedDB 仓库，校验迁移不是只在对话框中显示成功。
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("link", { name: /Source Control/ }).click();
    await expect(page.getByText("Working tree clean", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Migrate database repository" }),
    ).toBeVisible();

    const projectResponse = await page.request.get(`/api/projects/${project.id}`);
    expect(projectResponse.ok()).toBe(true);
    await expect(projectResponse.json()).resolves.toMatchObject({
      project: {
        id: project.id,
        storageKind: "browser_git",
        status: "ready",
      },
    });

    // clean 的 Source Control 不会把已提交文件列为 changed file；回到工作台读取
    // 同一 projectId 的 Browser Git 仓库，才能验证迁移后的源码快照仍然完整。
    await page.getByRole("link", { name: "返回 Agent 工作台" }).click();
    await expect(page).toHaveURL(new RegExp(`/p/${project.id}$`));
    await expect(
      page.getByRole("treeitem", { name: /src\/index\.tsx/ }),
    ).toBeVisible({
      timeout: 15_000,
    });
  });
});
