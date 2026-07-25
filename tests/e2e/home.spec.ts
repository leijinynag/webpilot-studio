import { expect, test } from "@playwright/test";

test("loads the projects shell and navigates to a project", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/WebPilot Studio/);
  await expect(
    page.getByRole("heading", { name: /Make something worth keeping/i }),
  ).toBeVisible();
  await page.getByRole("link", { name: /Atlas Finance/i }).click();
  await expect(page).toHaveURL(/\/p\/atlas-finance$/);
  await expect(page.getByText("Dashboard refinement")).toBeVisible();
});

test("exposes all 0.2 routes", async ({ page }) => {
  const routes = [
    "/",
    "/new",
    "/p/atlas-finance",
    "/p/atlas-finance/source-control",
    "/showcase",
    "/p/atlas-finance/publish",
  ];

  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("main").first()).toBeVisible();
  }
});

test("serves the app with WebContainer isolation headers", async ({ page }) => {
  const response = await page.goto("/p/atlas-finance");

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

  await page.goto("/p/atlas-finance");
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
