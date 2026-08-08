import { expect, test, type Page } from "@playwright/test";
import { postWithCsrf } from "./helpers/api";

const previewBaseURL = process.env.PLAYWRIGHT_BASE_URL;

async function enableVercelAutomationBypass(page: Page): Promise<void> {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  if (!bypassSecret) {
    return;
  }

  // 只在同源请求中发送 bypass secret，并让 Vercel 写入当前浏览器上下文的 Cookie。
  // 不能配置成全局 extraHTTPHeaders，否则 secret 可能跟随 iframe 请求发往 WebContainer 域名。
  const response = await page.request.get("/", {
    headers: {
      "x-vercel-protection-bypass": bypassSecret,
      "x-vercel-set-bypass-cookie": "samesitenone",
    },
  });

  expect(response.ok()).toBe(true);
}

async function createPreviewProject(page: Page): Promise<string> {
  await page.goto("/");
  const response = await postWithCsrf(page, "/api/projects", {
    data: {
      name: "Vercel preview smoke",
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

test.describe("Vercel Preview deployment", () => {
  test.skip(
    !previewBaseURL,
    "设置 PLAYWRIGHT_BASE_URL 后运行远程 Preview smoke。",
  );

  test("保留跨源隔离并完成真实 WebContainer 启动", async ({ page }) => {
    test.setTimeout(180_000);
    await enableVercelAutomationBypass(page);
    const projectId = await createPreviewProject(page);

    const response = await page.goto(`/p/${projectId}`);

    // 响应头和浏览器运行时状态必须同时通过，仅检查配置文件无法证明部署平台实际保留了 Header。
    expect(response?.headers()["cross-origin-opener-policy"]).toBe(
      "same-origin",
    );
    expect(response?.headers()["cross-origin-embedder-policy"]).toBe(
      "require-corp",
    );
    await expect
      .poll(() => page.evaluate(() => window.crossOriginIsolated))
      .toBe(true);

    // iframe 出现代表远程环境已经完成 boot、mount、install、dev server 和 server-ready 全链路。
    await expect(page.getByTitle("WebContainer 项目预览")).toBeVisible({
      timeout: 180_000,
    });
    await expect(page.getByTestId("preview-url")).toContainText(
      /https:\/\/\S*5173\S*/,
    );
  });
});
