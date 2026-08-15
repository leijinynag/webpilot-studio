import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { postWithCsrf } from "./helpers/api";
import { unzipSync } from "fflate";

const RUN_WEBCONTAINER_E2E = process.env.RUN_M8_WEBCONTAINER_E2E === "1";
const RUN_SHOWCASE_E2E = process.env.RUN_M8_SHOWCASE_E2E === "1";
const RUN_REMOTE_RUNTIME_E2E = process.env.RUN_M8_REMOTE_RUNTIME === "1";
const RUN_AGENT_E2E = process.env.RUN_M8_AGENT_E2E === "1";
const showcaseRuntimeBaseURL = process.env.SHOWCASE_RUNTIME_BASE_URL?.replace(
  /\/+$/,
  "",
);

type StorageKind = "database" | "browser_git";

type Project = {
  id: string;
  name?: string;
  revision: number;
  storageKind: StorageKind;
};

type ShowcaseCase = {
  id: string;
  slug: string;
  status: "draft" | "published" | "revoked";
  artifact: {
    id: string;
    sourceRevision: number;
  } | null;
};

type AgentRun = {
  id: string;
  conversationId: string;
  status: string;
  locale: "zh-CN" | "en-US";
  currentRevision: number;
  errorMessage: string | null;
};

type AgentSnapshot = {
  transcript: Array<{
    runId?: string | null;
    kind: string;
    content?: string;
  }>;
};

async function createProject(
  page: Page,
  input: {
    name: string;
    storageKind: StorageKind;
    template: "empty" | "rsbuild";
  },
): Promise<Project> {
  // 首次访问让 Proxy 建立匿名 owner，随后 page.request 会复用同一 Cookie。
  await page.goto("/");
  const response = await postWithCsrf(page, "/api/projects", { data: input });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { project: Project }).project;
}

async function createOwnedContext(page: Page): Promise<void> {
  await page.goto("/");
  // 每个 smoke 都显式固定初始语言，避免复用本地浏览器状态导致测试顺序
  // 影响结果。真实语言切换仍由页面按钮覆盖这个 Cookie。
  await page.evaluate(() => {
    document.cookie = "NEXT_LOCALE=zh; Path=/; Max-Age=31536000; SameSite=Lax";
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", /zh-CN|en-US/);
}

async function setPageLocale(page: Page, locale: "zh" | "en"): Promise<void> {
  // 直接写入与产品语言切换器相同的 Cookie，再通过完整导航读取新的
  // Server Component messages；这样六个路由都验证真实服务端 locale。
  await page.goto("/");
  await page.evaluate((nextLocale) => {
    document.cookie = `NEXT_LOCALE=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, locale);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "lang",
    locale === "zh" ? "zh-CN" : "en-US",
  );
}

async function expectNoMissingMessageKeys(page: Page): Promise<void> {
  // UI 适配层在翻译缺失时会回显完整 key。这里覆盖六个核心页面使用的
  // namespace，防止局部页面看似渲染成功但实际出现 publish.foo 一类文案。
  // 只检查可见主内容，避免 Next.js 注入到 body 中的 RSC/脚本序列化内容
  // 把合法的 sourceControl.foo 消息 key 误判成用户可见的缺失翻译。
  await expect(page.locator("main")).not.toContainText(
    /\b(?:common|nav|theme|workbench|projects|newProject|errors|agent|showcase|sourceControl|publish|changeSet|runtimeDiff)\.[a-z][\w.]*/,
  );
}

async function waitForRepositoryReady(page: Page): Promise<void> {
  // Browser Git 的恢复是客户端 IndexedDB/Worker 链路；只有 Explorer 出现后
  // 才能继续读取真实仓库，避免把“页面已打开”误当成“仓库已恢复”。
  await expect(page.getByLabel("Explorer")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByText(/正在恢复浏览器仓库|Restoring local repository/),
  ).toHaveCount(0, { timeout: 15_000 });
}

async function downloadProductionZip(
  page: Page,
  project: Project,
): Promise<Uint8Array> {
  test.setTimeout(240_000);
  await page.goto(`/p/${project.id}/publish`);

  const buildButton = page.getByRole("button", {
    name: /构建并下载 ZIP|Build & download ZIP/,
  });
  await expect(buildButton).toBeEnabled({ timeout: 30_000 });

  const downloadPromise = page.waitForEvent("download");
  await buildButton.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();

  expect(downloadPath).toBeTruthy();
  return new Uint8Array(
    await download.createReadStream().then(readStreamToBytes),
  );
}

async function readStreamToBytes(
  stream: NodeJS.ReadableStream | null,
): Promise<Uint8Array> {
  if (!stream) {
    throw new Error("下载没有返回可读流。");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function expectRunnableShowcaseZip(archive: Uint8Array): void {
  const entries = unzipSync(archive);
  const entryNames = Object.keys(entries);

  expect(entries["index.html"]).toBeDefined();
  expect(entries["webpilot-artifact.json"]).toBeDefined();
  expect(entryNames.some((path) => path.endsWith(".js"))).toBe(true);
  expect(new TextDecoder().decode(entries["index.html"])).not.toContain(
    'src="/',
  );
}

async function publishMinimalArtifact(
  request: APIRequestContext,
  projectId: string,
  adminToken: string,
  slug: string,
  options: {
    caseId?: string;
    title?: string;
    description?: string;
    sortOrder?: number;
    sourceRevision?: number;
    marker?: string;
  } = {},
): Promise<ShowcaseCase> {
  const marker = options.marker ?? "published";
  const indexContent = new TextEncoder().encode(
    `<!doctype html><html><body><h1>M8 Showcase ${marker}</h1><script src="./assets/app.js"></script></body></html>`,
  );
  const scriptContent = new TextEncoder().encode(
    `document.body.dataset.showcase = ${JSON.stringify(marker)};`,
  );
  const files = [
    { path: "index.html", content: indexContent },
    { path: "assets/app.js", content: scriptContent },
  ];
  const hashes = await Promise.all(files.map(({ content }) => sha256(content)));
  const manifest = {
    format: "webpilot-showcase-artifact-v1" as const,
    entryPath: "index.html" as const,
    files: files.map(({ path, content }, index) => ({
      path,
      byteLength: content.byteLength,
      hash: hashes[index],
    })),
    totalBytes: files.reduce(
      (total, file) => total + file.content.byteLength,
      0,
    ),
    createdAt: new Date().toISOString(),
  };
  const response = await request.post("/api/showcase/admin/publish", {
    headers: { "x-showcase-admin-token": adminToken },
    data: {
      caseId: options.caseId,
      projectId,
      title: options.title ?? "M8 E2E Showcase",
      slug,
      description: options.description,
      sortOrder: options.sortOrder,
      sourceRevision: options.sourceRevision ?? 1,
      manifest,
      files: files.map(({ path, content }, index) => ({
        path,
        hash: hashes[index],
        contentBase64: Buffer.from(content).toString("base64"),
      })),
    },
  });

  expect(response.status()).toBe(201);
  return ((await response.json()) as { case: ShowcaseCase }).case;
}

async function sha256(value: Uint8Array): Promise<string> {
  // 复制到普通 ArrayBuffer，避免 Node 类型声明把 Uint8Array 的底层
  // buffer 推断成 SharedArrayBuffer，导致 Web Crypto 类型不兼容。
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

test.describe("M8 export and i18n smoke", () => {
  test("empty Database and Browser Git projects stay empty until code exists", async ({
    page,
  }) => {
    await createOwnedContext(page);

    const databaseResponse = await postWithCsrf(page, "/api/projects", {
      data: {
        name: "M8 empty database",
        storageKind: "database",
        template: "empty",
      },
    });
    expect(databaseResponse.status()).toBe(201);
    const databaseProject = (
      (await databaseResponse.json()) as { project: Project }
    ).project;
    expect(databaseProject.revision).toBe(0);
    const databaseFilesResponse = await page.request.get(
      `/api/projects/${databaseProject.id}/files`,
    );
    expect(databaseFilesResponse.status()).toBe(200);
    expect(await databaseFilesResponse.json()).toMatchObject({ files: [] });

    const browserGitResponse = await postWithCsrf(page, "/api/projects", {
      data: {
        name: "M8 empty Browser Git",
        storageKind: "browser_git",
        template: "empty",
      },
    });
    expect(browserGitResponse.status()).toBe(201);
    const browserGitProject = (
      (await browserGitResponse.json()) as { project: Project }
    ).project;
    expect(browserGitProject.revision).toBe(0);

    await page.goto(`/p/${browserGitProject.id}`);
    await waitForRepositoryReady(page);
    await expect(page.getByLabel("Explorer")).toBeVisible();
    await expect(page.getByText(/暂无文件|No files/)).toBeVisible();
  });

  test("six core pages render complete Chinese and English UI", async ({
    page,
  }) => {
    await createOwnedContext(page);
    const project = await createProject(page, {
      name: "M8 locale pages",
      storageKind: "database",
      template: "empty",
    });

    for (const locale of ["zh", "en"] as const) {
      const isChinese = locale === "zh";
      await setPageLocale(page, locale);

      await page.goto("/");
      await expect(
        page.getByRole("link", {
          name: isChinese ? "项目" : "Projects",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".projects-lede")).toContainText(
        isChinese ? "从一个想法开始" : "Start with an idea",
      );
      await expectNoMissingMessageKeys(page);

      await page.goto("/new");
      await expect(page.locator(".create-steps")).toBeVisible();
      await expect(page.locator(".create-steps")).toHaveAttribute(
        "aria-label",
        isChinese ? "创建进度" : "Creation progress",
      );
      await expect(
        page.getByRole("link", {
          name: isChinese ? "取消" : "Cancel",
          exact: true,
        }),
      ).toBeVisible();
      await expectNoMissingMessageKeys(page);

      await page.goto(`/p/${project.id}`);
      // aria-label 是无障碍区域名称，标题文案单独验证，避免把可见标题
      // 与语义标签耦合在一起。Agent 顶部已改为紧凑的会话切换器，
      // 因此验证真实保留的可访问命令，不再要求已经删除的装饰性标题。
      await expect(page.getByLabel("Agent", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: isChinese ? "查看会话历史" : "View conversation history",
        }),
      ).toBeVisible();
      await expect(
        page.getByText(isChinese ? "暂无文件" : "No files yet.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: isChinese ? "发布" : "Publish",
          exact: true,
        }),
      ).toBeVisible();
      await expectNoMissingMessageKeys(page);

      await page.goto(`/p/${project.id}/source-control`);
      await expect(
        page.getByRole("heading", {
          name: isChinese
            ? "Source Control 以本地为先。"
            : "Source Control is local-first.",
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: isChinese ? "返回 Agent 工作台" : "Back to Agent workspace",
        }),
      ).toBeVisible();
      await expectNoMissingMessageKeys(page);

      await page.goto("/showcase");
      await expect(
        page.getByText(
          isChinese
            ? "探索从一句描述开始、经过真实运行和浏览器验证后发布的作品。每个案例都可以打开预览、查看代码与生成过程。"
            : "Explore work that started as a sentence, ran in a real environment, and passed browser verification. Open the preview, inspect the code, and see how it was made.",
          {
            exact: true,
          },
        ),
      ).toBeVisible();
      const emptyShowcase = page.getByText(
        isChinese ? "还没有公开案例" : "No public cases yet",
        { exact: true },
      );
      if ((await emptyShowcase.count()) > 0) {
        await expect(emptyShowcase).toBeVisible();
      } else {
        // Showcase 可能已经存在其他测试或手工发布的公开案例；两种状态
        // 都是合法页面结果，测试只要求页面主体能稳定呈现。
        await expect(page.locator(".showcase-piece").first()).toBeVisible();
      }
      await expectNoMissingMessageKeys(page);

      await page.goto(`/p/${project.id}/publish`);
      await expect(
        page
          .getByRole("status")
          .getByText(isChinese ? "尚未构建" : "Not built yet", {
            exact: true,
          }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", {
          name: isChinese ? "返回 Agent 工作台" : "Back to Agent workspace",
        }),
      ).toBeVisible();
      await expectNoMissingMessageKeys(page);
    }
  });
});

test.describe("M8 production ZIP", () => {
  test.skip(
    !RUN_WEBCONTAINER_E2E,
    "设置 RUN_M8_WEBCONTAINER_E2E=1 后执行真实 WebContainer production build。",
  );

  for (const storageKind of ["database", "browser_git"] as const) {
    test(`${storageKind} Repository 导出的 production ZIP 可独立读取入口`, async ({
      page,
    }) => {
      const project = await createProject(page, {
        name: `M8 ${storageKind} production export`,
        storageKind,
        template: "rsbuild",
      });
      await page.goto(`/p/${project.id}`);
      if (storageKind === "browser_git") {
        await waitForRepositoryReady(page);
      }

      const archive = await downloadProductionZip(page, project);
      expectRunnableShowcaseZip(archive);
    });
  }
});

test.describe("M8 Showcase publish and revoke", () => {
  test.skip(
    !RUN_SHOWCASE_E2E,
    "设置 RUN_M8_SHOWCASE_E2E=1，并配置数据库、Blob 和 SHOWCASE_ADMIN_TOKEN 后执行发布撤销链路。",
  );

  test("管理员可发布、更新并撤销 Showcase，所有公开入口同步失效", async ({
    page,
  }) => {
    const adminToken = process.env.SHOWCASE_ADMIN_TOKEN;
    expect(adminToken).toBeTruthy();
    const project = await createProject(page, {
      name: "M8 showcase lifecycle",
      storageKind: "database",
      template: "empty",
    });
    const slug = `m8-showcase-${Date.now()}`;
    const published = await publishMinimalArtifact(
      page.request,
      project.id,
      adminToken!,
      slug,
    );
    expect(published.status).toBe("published");
    expect(published.artifact?.id).toBeTruthy();

    const listResponse = await page.request.get("/api/showcase");
    expect(listResponse.status()).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      cases: expect.arrayContaining([
        expect.objectContaining({
          id: published.id,
          status: "published",
        }),
      ]),
    });

    const detailResponse = await page.request.get(`/api/showcase/${slug}`);
    expect(detailResponse.status()).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      case: { id: published.id, status: "published" },
    });

    const firstArtifactId = published.artifact!.id;
    const firstRuntimeResponse = await page.request.get(
      `/showcase/runtime/${firstArtifactId}/`,
    );
    expect(firstRuntimeResponse.status()).toBe(200);
    expect(await firstRuntimeResponse.text()).toContain(
      "M8 Showcase published",
    );

    // 使用同一个 caseId 再次发布，验证管理员配置更新会创建不可变新 artifact，
    // 并立即让旧 artifact 退出公开读取链路。
    const updated = await publishMinimalArtifact(
      page.request,
      project.id,
      adminToken!,
      slug,
      {
        caseId: published.id,
        title: "M8 E2E Showcase Updated",
        description: "Updated by the M8 lifecycle E2E.",
        sortOrder: -8,
        sourceRevision: 2,
        marker: "updated",
      },
    );
    expect(updated.id).toBe(published.id);
    expect(updated.artifact?.id).not.toBe(firstArtifactId);
    expect(updated.artifact?.sourceRevision).toBe(2);
    expect(
      (
        await page.request.get(`/showcase/runtime/${firstArtifactId}/`)
      ).status(),
    ).toBe(404);

    const updatedDetailResponse = await page.request.get(
      `/api/showcase/${slug}`,
    );
    expect(updatedDetailResponse.status()).toBe(200);
    await expect(updatedDetailResponse.json()).resolves.toMatchObject({
      case: {
        id: published.id,
        title: "M8 E2E Showcase Updated",
        description: "Updated by the M8 lifecycle E2E.",
        sortOrder: -8,
        artifact: {
          id: updated.artifact!.id,
          sourceRevision: 2,
        },
      },
    });

    const activeRuntimeResponse = await page.request.get(
      `/showcase/runtime/${updated.artifact!.id}/`,
    );
    expect(activeRuntimeResponse.status()).toBe(200);
    expect(await activeRuntimeResponse.text()).toContain("M8 Showcase updated");

    const revokeResponse = await page.request.post(
      `/api/showcase/admin/${published.id}/revoke`,
      { headers: { "x-showcase-admin-token": adminToken! } },
    );
    expect(revokeResponse.status()).toBe(200);
    expect((await page.request.get(`/api/showcase/${slug}`)).status()).toBe(
      404,
    );
    expect((await page.request.get("/api/showcase")).status()).toBe(200);
    expect((await page.request.get(`/api/showcase/${slug}`)).status()).toBe(
      404,
    );
    expect(
      (
        await page.request.get(`/showcase/runtime/${updated.artifact!.id}/`)
      ).status(),
    ).toBe(404);

    const revokedList = (await (
      await page.request.get("/api/showcase")
    ).json()) as { cases: ShowcaseCase[] };
    expect(revokedList.cases).not.toContainEqual(
      expect.objectContaining({ id: published.id }),
    );
  });
});

test.describe("M8 independent Showcase Runtime", () => {
  test.skip(
    !RUN_REMOTE_RUNTIME_E2E || !showcaseRuntimeBaseURL,
    "设置 RUN_M8_REMOTE_RUNTIME=1 和 SHOWCASE_RUNTIME_BASE_URL 后执行独立 origin smoke。",
  );

  test("Runtime 只提供 health 和 artifact 路径，不携带主站会话", async ({
    browser,
  }) => {
    const primary = await browser.newContext();
    const runtime = await browser.newContext();
    const primaryPage = await primary.newPage();
    await primaryPage.goto("/");
    const primaryCookies = await primary.cookies();
    expect(primaryCookies.length).toBeGreaterThan(0);

    const health = await runtime.request.get(
      `${showcaseRuntimeBaseURL}/health`,
    );
    expect(health.status()).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      deployment: "showcase-runtime",
      runtimeOnly: true,
    });
    expect((await runtime.cookies()).length).toBe(0);

    const root = await runtime.request.get(`${showcaseRuntimeBaseURL}/`);
    expect(root.status()).toBe(404);
    expect(root.headers()["content-type"]).toContain("text/html");

    const api = await runtime.request.get(
      `${showcaseRuntimeBaseURL}/api/showcase`,
    );
    expect(api.status()).toBe(404);

    const artifactId = process.env.SHOWCASE_ARTIFACT_ID;
    if (artifactId) {
      const entry = await runtime.request.get(
        `${showcaseRuntimeBaseURL}/showcase/runtime/${artifactId}/`,
      );
      expect(entry.status()).toBe(200);
      expect(entry.headers()["content-security-policy"]).toContain(
        "connect-src 'none'",
      );
      expect(entry.headers()["cross-origin-resource-policy"]).toBe(
        "same-origin",
      );
    }

    await primary.close();
    await runtime.close();
  });
});

test.describe("M8 Agent locale", () => {
  // 真实 Agent 会经历项目读取、模型工具调用和最终回复等多轮执行，单次 Run
  // 合理耗时可能超过 Playwright 默认的 30 秒。这里保留 240 秒业务轮询窗口，
  // 并给测试本身额外预留项目创建、接口查询与 transcript 断言时间。
  test.describe.configure({ timeout: 300_000 });

  test.skip(
    !RUN_AGENT_E2E,
    "设置 RUN_M8_AGENT_E2E=1，并配置 DeepSeek Agent 环境后执行中英文 Run smoke。",
  );

  for (const locale of ["zh-CN", "en-US"] as const) {
    test(`Agent ${locale} Run 使用冻结语言配置`, async ({ page }) => {
      const project = await createProject(page, {
        name: `M8 ${locale} agent`,
        storageKind: "database",
        template: "rsbuild",
      });
      const response = await postWithCsrf(page, "/api/agent-runs", {
        data: {
          projectId: project.id,
          message:
            locale === "en-US"
              ? "Reply briefly in English after checking the project."
              : "检查项目后请用简体中文简短回复。",
          locale,
        },
      });
      expect(response.status()).toBe(201);
      const run = ((await response.json()) as { run: AgentRun }).run;
      expect(run.locale).toBe(locale);

      const deadline = Date.now() + 240_000;
      let finalRun = run;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        const statusResponse = await page.request.get(
          `/api/agent-runs/${run.id}`,
        );
        expect(statusResponse.status()).toBe(200);
        finalRun = ((await statusResponse.json()) as { run: AgentRun }).run;
        if (
          ["succeeded", "failed", "cancelled", "budget_exhausted"].includes(
            finalRun.status,
          )
        ) {
          break;
        }
      }

      expect(
        finalRun.status,
        finalRun.errorMessage ?? "Agent Run 未在期限内完成。",
      ).toBe("succeeded");
      expect(finalRun.locale).toBe(locale);

      const snapshotResponse = await page.request.get(
        `/api/projects/${project.id}/agent?conversationId=${run.conversationId}`,
      );
      expect(snapshotResponse.status()).toBe(200);
      const snapshot = (
        (await snapshotResponse.json()) as {
          snapshot: AgentSnapshot | null;
        }
      ).snapshot;
      expect(snapshot).not.toBeNull();

      const assistantReply = snapshot!.transcript
        .filter(
          (message) =>
            message.runId === run.id &&
            message.kind === "assistant_message" &&
            typeof message.content === "string",
        )
        .at(-1)?.content;
      expect(assistantReply).toBeTruthy();

      if (locale === "zh-CN") {
        expect(assistantReply).toMatch(/[\u3400-\u9fff]/u);
      } else {
        expect(assistantReply).toMatch(/[A-Za-z]/);
        expect(assistantReply).not.toMatch(/[\u3400-\u9fff]/u);
      }
    });
  }
});
