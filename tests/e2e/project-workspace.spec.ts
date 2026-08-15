import { expect, test, type Browser, type Page } from "@playwright/test";
import { getWithBrowserSession, postWithCsrf } from "./helpers/api";

type ProjectResponse = {
  project: {
    id: string;
    revision: number;
  };
};

type FileResponse = {
  file: {
    content: string;
    path: string;
  };
};

type CompletionMetric = {
  name: string;
  reason?: string;
};

function createDeferred() {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise(),
  };
}

async function createProject(
  page: Page,
  name: string,
): Promise<ProjectResponse["project"]> {
  const response = await postWithCsrf(page, "/api/projects", {
    data: {
      name,
      storageKind: "database",
      template: "rsbuild",
    },
  });

  expect(response.status()).toBe(201);
  return ((await response.json()) as ProjectResponse).project;
}

async function createOwnedContext(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  // Proxy 在首次页面请求时签发匿名 Cookie，随后 context.request 会复用同一会话。
  await page.goto("/");
  return { context, page, request: context.request };
}

test("persists multiple file revisions and restores the latest snapshot", async ({
  browser,
  baseURL,
}) => {
  const owned = await createOwnedContext(browser, baseURL!);

  try {
    const project = await createProject(
      owned.page,
      "M1 multi-file persistence",
    );
    const firstWrite = await postWithCsrf(
      owned.page,
      `/api/projects/${project.id}/files`,
      {
        data: {
          path: "src/index.tsx",
          content: "export const revisionTwo = true;\n",
          expectedRevision: project.revision,
        },
      },
    );
    expect(firstWrite.ok()).toBe(true);
    const firstBody = (await firstWrite.json()) as {
      result: { revision: number };
    };

    const secondWrite = await postWithCsrf(
      owned.page,
      `/api/projects/${project.id}/files`,
      {
        data: {
          path: "src/m1-proof.ts",
          content: "export const restored = 'repository';\n",
          expectedRevision: firstBody.result.revision,
        },
      },
    );
    expect(secondWrite.ok()).toBe(true);
    const secondBody = (await secondWrite.json()) as {
      result: { revision: number };
    };

    // 页面刷新重新走 Server Component 查询，文件树与 revision 必须来自数据库快照。
    await owned.page.goto(`/p/${project.id}`);
    await owned.page.reload();
    await expect(
      owned.page.getByLabel(
        `Repository revision ${secondBody.result.revision}`,
      ),
    ).toBeVisible();
    await expect(
      owned.page.getByText("m1-proof.ts", { exact: true }),
    ).toBeVisible();

    const restored = await getWithBrowserSession(
      owned.page,
      `/api/projects/${project.id}/files/src/m1-proof.ts`,
      {},
      owned.request,
    );
    expect(restored.ok()).toBe(true);
    expect((await restored.json()) as FileResponse).toMatchObject({
      file: {
        path: "src/m1-proof.ts",
        content: "export const restored = 'repository';\n",
      },
    });
  } finally {
    await owned.context.close();
  }
});

test("edits and saves multiple files from the Monaco workspace", async ({
  browser,
  baseURL,
}) => {
  // 数据库密集型 E2E 还包含 Monaco 动态 chunk 首次编译，测试总时限需要
  // 覆盖页面加载、编辑器挂载和两次真实 Repository 写入。
  test.setTimeout(90_000);
  const owned = await createOwnedContext(browser, baseURL!);

  try {
    const project = await createProject(owned.page, "M1 Monaco workflow");
    await owned.page.goto(`/p/${project.id}`);
    await owned.page.getByRole("radio", { name: "Code" }).click();

    const editor = owned.page.locator(".monaco-editor");
    // Monaco 是独立的动态 chunk；首次开发态编译可能明显慢于普通组件，
    // 这里等待真实编辑器挂载，而不是把 Next.js 的编译时间误判成工作区失败。
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await owned.page.keyboard.press("ControlOrMeta+A");
    await owned.page.keyboard.type(
      "export function App() { return <main>M1 saved from Monaco</main>; }\n",
    );
    await expect(
      owned.page.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
    await owned.page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      owned.page.getByText(/Revision 2 (?:已保存|saved)/, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    await owned.page
      .getByRole("button", { name: "styles.css", exact: true })
      .click();
    await editor.click();
    await owned.page.keyboard.press("ControlOrMeta+A");
    await owned.page.keyboard.type(
      "body { margin: 0; background: #111; color: #fff; }\n",
    );
    // Playwright 的 Desktop Chrome 上下文使用 Windows 平台语义，
    // Monaco 因而把 CtrlCmd 注册为 Control；这里直接验证对应快捷键。
    await owned.page.keyboard.press("Control+S");
    await expect(
      owned.page.getByText(/Revision 3 (?:已保存|saved)/, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    const [indexFile, stylesFile] = await Promise.all([
      getWithBrowserSession(
        owned.page,
        `/api/projects/${project.id}/files/src/index.tsx`,
        {},
        owned.request,
      ),
      getWithBrowserSession(
        owned.page,
        `/api/projects/${project.id}/files/src/styles.css`,
        {},
        owned.request,
      ),
    ]);
    await expect(indexFile.json()).resolves.toMatchObject({
      file: { content: expect.stringContaining("M1 saved from Monaco") },
    });
    await expect(stylesFile.json()).resolves.toMatchObject({
      file: { content: expect.stringContaining("background: #111") },
    });

    await owned.page.reload();
    await expect(owned.page.getByLabel("Repository revision 3")).toBeVisible();
  } finally {
    await owned.context.close();
  }
});

test("shows, accepts and invalidates Monaco AI inline completions", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const owned = await createOwnedContext(browser, baseURL!);
  let completionRequestCount = 0;
  const staleRequest = createDeferred();
  const staleResponse = createDeferred();

  try {
    const project = await createProject(
      owned.page,
      "Monaco inline completion workflow",
    );

    // 禁用自动触发以隔离显式补全链路，同时在页面初始化阶段注册指标监听。
    // addInitScript 会在项目页脚本执行前生效，不会漏掉 Provider 的首个 request。
    await owned.page.addInitScript(() => {
      window.localStorage.setItem(
        "webpilot:code-completion-preference:v1",
        JSON.stringify({ version: 1, enabled: false }),
      );
      const metrics: CompletionMetric[] = [];
      (
        window as typeof window & {
          __webpilotCompletionMetrics?: CompletionMetric[];
        }
      ).__webpilotCompletionMetrics = metrics;
      window.addEventListener("webpilot:code-completion-metric", (event) => {
        metrics.push((event as CustomEvent<CompletionMetric>).detail);
      });
    });

    await owned.page.route(
      `**/api/projects/${project.id}/code-completions`,
      async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              configured: true,
              model: "e2e-completion",
              provider: "deepseek",
            }),
          });
          return;
        }

        completionRequestCount += 1;
        if (completionRequestCount === 2) {
          // 第二次响应故意悬停，等待测试修改 Monaco model version。
          // 这样可以覆盖真实网络仍在飞行时的 stale-result 防护，而非只测纯函数。
          staleRequest.resolve();
          await staleResponse.promise;
        }

        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            requestId:
              completionRequestCount === 1
                ? "22222222-2222-4222-8222-222222222222"
                : "33333333-3333-4333-8333-333333333333",
            projectRevision:
              completionRequestCount === 1 ? project.revision : 2,
            insertText: completionRequestCount === 1 ? "42;" : "STALE_RESULT;",
            model: "e2e-completion",
            latencyMs: 8,
            firstResultLatencyMs: 5,
            cacheHit: false,
          }),
        });
      },
    );

    await owned.page.goto(`/p/${project.id}`);
    const codeView = owned.page.getByRole("radio", { name: "Code" });
    await expect
      .poll(
        async () => {
          if (!(await codeView.isChecked())) {
            await codeView.click();
          }
          return codeView.isChecked();
        },
        {
          // 开发态首轮编译可能在 React hydration 前让原生点击先发生。
          // 以受控 radio 的最终状态为准重试，避免绑定 Next 内部缓存或请求时序。
          timeout: 15_000,
        },
      )
      .toBe(true);

    const editor = owned.page.locator(".monaco-editor");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await owned.page.keyboard.press("ControlOrMeta+A");
    await owned.page.keyboard.type("const answer = ");

    const completionButton = owned.page.getByRole("button", {
      name: /AI (?:行内补全|inline completion)/,
    });
    await expect(completionButton).toBeVisible();
    await completionButton.click();
    await expect(owned.page.getByText("e2e-completion")).toBeVisible();
    await owned.page
      .getByRole("menuitem", {
        name: /(?:立即生成补全|Generate completion now)/,
      })
      .click();

    // Monaco 的 ghost text 属于编辑器渲染层，不会进入 textarea value。
    // 先证明建议真实展示，再按 Tab 接受并保存到 Repository 验证最终内容。
    await expect(
      owned.page.locator(".monaco-editor .view-lines").getByText("42;", {
        exact: false,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await owned.page.keyboard.press("Tab");
    await owned.page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      owned.page.getByText(/Revision 2 (?:已保存|saved)/, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    const acceptedFile = await getWithBrowserSession(
      owned.page,
      `/api/projects/${project.id}/files/src/index.tsx`,
      {},
      owned.request,
    );
    await expect(acceptedFile.json()).resolves.toMatchObject({
      file: { content: expect.stringContaining("const answer = 42;") },
    });

    await editor.click();
    await owned.page.keyboard.press("ControlOrMeta+A");
    await owned.page.keyboard.type("const stale = ");
    await completionButton.click();
    await owned.page
      .getByRole("menuitem", {
        name: /(?:立即生成补全|Generate completion now)/,
      })
      .click();
    await staleRequest.promise;

    // 请求发出后继续输入会改变 Monaco model version，并取消当前建议。
    // 即使服务端稍后返回成功，旧结果也必须被 Provider 丢弃，不能污染草稿。
    await owned.page.keyboard.type("user_kept_typing");
    staleResponse.resolve();
    await expect
      .poll(async () => completionRequestCount, { timeout: 10_000 })
      .toBe(2);
    await owned.page.waitForTimeout(500);
    await expect(
      owned.page.locator(".monaco-editor .view-lines"),
    ).not.toContainText("STALE_RESULT");

    const metricNames = await owned.page.evaluate(() =>
      (
        window as typeof window & {
          __webpilotCompletionMetrics?: CompletionMetric[];
        }
      ).__webpilotCompletionMetrics?.map((metric) => metric.name),
    );
    expect(metricNames).toEqual(
      expect.arrayContaining(["request", "first_result", "shown", "accepted"]),
    );
  } finally {
    staleResponse.resolve();
    await owned.context.close();
  }
});

test("rejects a stale revision without overwriting the winning content", async ({
  browser,
  baseURL,
}) => {
  const owned = await createOwnedContext(browser, baseURL!);

  try {
    const project = await createProject(owned.page, "M1 conflict proof");
    const winningContent = "export const winner = 'first writer';\n";
    const winningWrite = await postWithCsrf(
      owned.page,
      `/api/projects/${project.id}/files`,
      {
        data: {
          path: "src/index.tsx",
          content: winningContent,
          expectedRevision: project.revision,
        },
      },
    );
    expect(winningWrite.ok()).toBe(true);

    const staleWrite = await postWithCsrf(
      owned.page,
      `/api/projects/${project.id}/files`,
      {
        data: {
          path: "src/index.tsx",
          content: "export const loser = 'stale writer';\n",
          expectedRevision: project.revision,
        },
      },
    );
    expect(staleWrite.status()).toBe(409);
    await expect(staleWrite.json()).resolves.toMatchObject({
      error: {
        code: "PROJECT_REVISION_CONFLICT",
        details: {
          actualRevision: project.revision + 1,
          expectedRevision: project.revision,
        },
      },
    });

    const file = await getWithBrowserSession(
      owned.page,
      `/api/projects/${project.id}/files/src/index.tsx`,
      {},
      owned.request,
    );
    expect(file.ok()).toBe(true);
    expect((await file.json()) as FileResponse).toMatchObject({
      file: {
        content: winningContent,
      },
    });
  } finally {
    await owned.context.close();
  }
});

test("keeps projects isolated between anonymous owners", async ({
  browser,
  baseURL,
}) => {
  const ownerA = await createOwnedContext(browser, baseURL!);
  const ownerB = await createOwnedContext(browser, baseURL!);

  try {
    const project = await createProject(ownerA.page, "Owner A private");
    const foreignProject = await getWithBrowserSession(
      ownerB.page,
      `/api/projects/${project.id}`,
      {},
      ownerB.request,
    );
    const foreignFiles = await getWithBrowserSession(
      ownerB.page,
      `/api/projects/${project.id}/files`,
      {},
      ownerB.request,
    );

    // 对外统一表现为 not found，避免泄漏另一个匿名 owner 的项目是否存在。
    expect(foreignProject.status()).toBe(404);
    expect(foreignFiles.status()).toBe(404);

    const ownerBList = await getWithBrowserSession(
      ownerB.page,
      "/api/projects",
      {},
      ownerB.request,
    );
    expect(ownerBList.ok()).toBe(true);
    await expect(ownerBList.json()).resolves.toMatchObject({ projects: [] });
  } finally {
    await Promise.all([ownerA.context.close(), ownerB.context.close()]);
  }
});
