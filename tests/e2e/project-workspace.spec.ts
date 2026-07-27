import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
} from "@playwright/test";

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

async function createProject(
  request: APIRequestContext,
  name: string,
): Promise<ProjectResponse["project"]> {
  const response = await request.post("/api/projects", {
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
      owned.request,
      "M1 multi-file persistence",
    );
    const firstWrite = await owned.request.post(
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

    const secondWrite = await owned.request.post(
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

    const restored = await owned.request.get(
      `/api/projects/${project.id}/files/src/m1-proof.ts`,
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
  const owned = await createOwnedContext(browser, baseURL!);

  try {
    const project = await createProject(owned.request, "M1 Monaco workflow");
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
      owned.page.getByRole("button", { name: "Save" }),
    ).toBeEnabled();
    await owned.page.getByRole("button", { name: "Save" }).click();
    await expect(
      owned.page.getByText("Revision 2 已保存", { exact: true }),
    ).toBeVisible();

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
      owned.page.getByText("Revision 3 已保存", { exact: true }),
    ).toBeVisible();

    const [indexFile, stylesFile] = await Promise.all([
      owned.request.get(`/api/projects/${project.id}/files/src/index.tsx`),
      owned.request.get(`/api/projects/${project.id}/files/src/styles.css`),
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

test("rejects a stale revision without overwriting the winning content", async ({
  browser,
  baseURL,
}) => {
  const owned = await createOwnedContext(browser, baseURL!);

  try {
    const project = await createProject(owned.request, "M1 conflict proof");
    const winningContent = "export const winner = 'first writer';\n";
    const winningWrite = await owned.request.post(
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

    const staleWrite = await owned.request.post(
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

    const file = await owned.request.get(
      `/api/projects/${project.id}/files/src/index.tsx`,
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
    const project = await createProject(ownerA.request, "Owner A private");
    const foreignProject = await ownerB.request.get(
      `/api/projects/${project.id}`,
    );
    const foreignFiles = await ownerB.request.get(
      `/api/projects/${project.id}/files`,
    );

    // 对外统一表现为 not found，避免泄漏另一个匿名 owner 的项目是否存在。
    expect(foreignProject.status()).toBe(404);
    expect(foreignFiles.status()).toBe(404);

    const ownerBList = await ownerB.request.get("/api/projects");
    expect(ownerBList.ok()).toBe(true);
    await expect(ownerBList.json()).resolves.toMatchObject({ projects: [] });
  } finally {
    await Promise.all([ownerA.context.close(), ownerB.context.close()]);
  }
});
