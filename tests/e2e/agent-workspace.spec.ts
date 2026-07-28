import { expect, test, type Page } from "@playwright/test";

const AGENT_E2E_ENABLED = process.env.RUN_AGENT_E2E === "1";
const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
  "conflicted",
]);

type Project = {
  id: string;
  revision: number;
};

type Run = {
  id: string;
  conversationId: string;
  status: string;
  currentRevision: number;
  errorMessage: string | null;
};

async function createProject(page: Page, name: string): Promise<Project> {
  // 先建立匿名 owner Cookie；项目 API 和工作台请求必须共享同一浏览器会话。
  await page.goto("/");
  const response = await page.request.post("/api/projects", {
    data: {
      name,
      storageKind: "database",
      template: "rsbuild",
    },
  });

  expect(response.status()).toBe(201);
  const body = (await response.json()) as { project: Project };
  return body.project;
}

async function waitForTerminalRun(
  page: Page,
  runId: string,
  timeout = 180_000,
): Promise<Run> {
  let lastRun: Run | null = null;

  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/agent-runs/${runId}`);
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as { run: Run };
        lastRun = body.run;
        return TERMINAL_STATUSES.has(body.run.status);
      },
      { timeout, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);

  if (!lastRun) {
    throw new Error("Agent Run 已进入终态，但没有读取到最终记录。");
  }

  return lastRun;
}

test.describe("Agent workspace live flow", () => {
  test.skip(
    !AGENT_E2E_ENABLED,
    "设置 RUN_AGENT_E2E=1，并配置 LLM_PROVIDER、LLM_API_KEY、AGENT_ENABLED 后运行真实 Agent E2E。",
  );

  test("completes a natural-language edit and restores the conversation after refresh", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const project = await createProject(page, "M2 live agent edit");
    await page.goto(`/p/${project.id}`);

    await expect(
      page.getByRole("complementary", { name: "Agent" }),
    ).toBeVisible();
    const prompt =
      "读取 src/index.tsx，把页面 h1 文案改成 M2 Live Agent Verified。完成后说明修改了哪些文件。";
    await page.getByLabel("给 Agent 的消息").fill(prompt);
    await page.getByRole("button", { name: "发送消息" }).click();

    const runResponse = await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/agent-runs") &&
        response.request().method() === "POST",
    );
    expect(runResponse.status()).toBe(201);
    const runBody = (await runResponse.json()) as { run: Run };
    const run = await waitForTerminalRun(page, runBody.run.id);

    expect(run.status, run.errorMessage ?? "Agent Run 未成功完成。").toBe(
      "succeeded",
    );
    expect(run.currentRevision).toBeGreaterThan(project.revision);

    const fileResponse = await page.request.get(
      `/api/projects/${project.id}/files/src/index.tsx`,
    );
    expect(fileResponse.ok()).toBe(true);
    await expect(fileResponse.json()).resolves.toMatchObject({
      file: {
        content: expect.stringContaining("M2 Live Agent Verified"),
      },
    });

    // 页面重新加载后，Transcript 仍应来自 Conversation 聚合快照，而不是内存状态。
    await page.reload();
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel(`Repository revision ${run.currentRevision}`),
    ).toBeVisible();
  });

  test("stops a run before it can mutate the repository", async ({ page }) => {
    test.setTimeout(120_000);
    const project = await createProject(page, "M2 live agent stop");
    await page.goto(`/p/${project.id}`);

    const createRunResponse = await page.request.post("/api/agent-runs", {
      data: {
        projectId: project.id,
        message:
          "请先读取项目结构，然后做一次复杂的页面重构；在没有完成全部分析前不要结束。",
        locale: "zh-CN",
      },
    });
    expect(createRunResponse.status()).toBe(201);
    const createRunBody = (await createRunResponse.json()) as { run: Run };

    // API 立即发送取消请求，验证服务端 fence；这比依赖模型响应速度的 UI 点击更稳定。
    const cancelResponse = await page.request.post(
      `/api/agent-runs/${createRunBody.run.id}/cancel`,
    );
    expect(cancelResponse.ok()).toBe(true);
    const cancelledBody = (await cancelResponse.json()) as { run: Run };
    expect(cancelledBody.run.status).toBe("cancelled");

    const finalRun = await waitForTerminalRun(page, createRunBody.run.id);
    expect(finalRun.status).toBe("cancelled");
    expect(finalRun.currentRevision).toBe(project.revision);

    const fileResponse = await page.request.get(
      `/api/projects/${project.id}/files/src/index.tsx`,
    );
    expect(fileResponse.ok()).toBe(true);
    await expect(fileResponse.json()).resolves.toMatchObject({
      file: {
        content: expect.not.stringContaining("复杂的页面重构"),
      },
    });
  });
});
