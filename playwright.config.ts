import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const localBaseURL = `http://127.0.0.1:${port}`;
// CI 在 Vercel 部署完成后传入 Preview URL；未传入时继续启动本地开发服务器，
// 让同一套测试既能用于开发回归，也能验证真实部署环境。
const remoteBaseURL = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/+$/, "");
const baseURL = remoteBaseURL ?? localBaseURL;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // 远程 smoke 直接访问 Vercel URL，不能再额外拉起本地 Next.js。
  ...(remoteBaseURL
    ? {}
    : {
        webServer: {
          command: `pnpm dev --hostname 127.0.0.1 --port ${port}`,
          url: localBaseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
