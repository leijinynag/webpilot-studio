import { expect, test } from "@playwright/test";

test("loads the application shell", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/WebPilot Studio/);
  await expect(page.getByText("Hello world!")).toBeVisible();
});
