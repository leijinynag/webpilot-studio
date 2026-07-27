import { expect, test, type Page } from "@playwright/test";

async function createProject(page: Page, name: string): Promise<string> {
  // 先访问页面让 proxy 建立匿名会话；API 与后续页面会共享同一个浏览器 Cookie。
  await page.goto("/");
  const response = await page.request.post("/api/projects", {
    data: {
      name,
      storageKind: "database",
      template: "rsbuild",
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as {
    project: { id: string };
  };

  return body.project.id;
}

test("creates a project, restores it after refresh, and opens the workbench", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/WebPilot Studio/);
  await expect(
    page.getByRole("heading", { name: /Make something worth keeping/i }),
  ).toBeVisible();

  await page.getByRole("link", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("E2E persisted project");
  await page.getByRole("button", { name: "Create project" }).click();
  // 该流程会在 Neon 事务内创建项目并写入完整模板；并行 E2E 下网络数据库
  // 可能超过 Playwright 默认的 5 秒断言窗口，但 UI 会持续展示 Creating 状态。
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  // 工作台不再依赖 M0 阶段的临时 Agent 文案，改为校验真实 M1 编辑器骨架。
  await expect(page.getByText("E2E persisted project")).toBeVisible();
  await expect(page.getByLabel("Explorer")).toBeVisible();
  await expect(page.getByLabel("Repository revision 1")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Preview", exact: true }),
  ).toBeVisible();

  const projectURL = page.url();
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "打开 E2E persisted project" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "打开 E2E persisted project" }).click();
  await expect(page).toHaveURL(projectURL);
});

test("soft deletes and restores a project from the workspace", async ({
  page,
}) => {
  await createProject(page, "Recoverable project");
  await page.reload();

  await page.getByRole("button", { name: "删除 Recoverable project" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "打开 Recoverable project" }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "恢复 Recoverable project" }).click();
  await expect(
    page.getByRole("link", { name: "打开 Recoverable project" }),
  ).toBeVisible();
});

test("exposes all 0.2 routes", async ({ page }) => {
  const projectId = await createProject(page, "Route coverage project");
  const routes = [
    "/",
    "/new",
    `/p/${projectId}`,
    `/p/${projectId}/source-control`,
    "/showcase",
    `/p/${projectId}/publish`,
  ];

  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("main").first()).toBeVisible();
  }
});

test("serves the app with WebContainer isolation headers", async ({ page }) => {
  const projectId = await createProject(page, "Isolation project");
  const response = await page.goto(`/p/${projectId}`);

  // 不只检查配置文件，还从真实文档响应与浏览器能力两侧确认隔离确实生效。
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe(
    "require-corp",
  );
  await expect
    .poll(() => page.evaluate(() => window.crossOriginIsolated))
    .toBe(true);
  await expect(page.getByTestId("webcontainer-runtime")).toHaveAttribute(
    "data-phase",
    /booting|mounting|installing|starting|failed/,
  );

  const viewportToggle = page.getByTestId("preview-viewport-toggle");
  await viewportToggle.click();
  await expect(viewportToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("preview-stage")).toHaveClass(
    /preview-stage-compact/,
  );
});

test("boots a real WebContainer preview when live smoke is enabled", async ({
  page,
}) => {
  // 真实 npm 安装受网络和浏览器资源影响，只在显式开启时运行，常规 E2E 保持快速稳定。
  test.setTimeout(180_000);
  test.skip(
    process.env.RUN_WEBCONTAINER_SMOKE !== "1",
    "设置 RUN_WEBCONTAINER_SMOKE=1 后执行真实浏览器安装与 dev server smoke。",
  );

  const projectId = await createProject(page, "Live WebContainer project");
  await page.goto(`/p/${projectId}`);
  await expect(page.getByTitle("WebContainer 项目预览")).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByTestId("preview-url")).toContainText(
    /https:\/\/\S*5173\S*/,
  );

  await page.getByRole("button", { name: "刷新预览" }).click();
  await expect(page.getByTitle("WebContainer 项目预览")).toBeVisible();
});

test("persists the dark theme preference", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "切换主题" }).click();
  await page.getByRole("menuitemradio", { name: "暗色主题" }).click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(3, 3, 4)",
  );

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
