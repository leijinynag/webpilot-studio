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
