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
  usage?: {
    clientResumes: number;
    repairRounds: number;
    latestVerificationRevision: number | null;
    latestVerificationOk: boolean | null;
  };
};

type ToolInvocation = {
  runId: string;
  toolName: string;
  status: string;
  resultJson: {
    ok?: boolean;
    build?: { errors?: string[] };
    runtime?: {
      rendered?: boolean;
      events?: Array<{ type?: string; message?: string }>;
    };
  } | null;
};

type AgentSnapshot = {
  tools: ToolInvocation[];
  events: Array<{
    type: string;
    payload: Record<string, unknown>;
  }>;
  transcript: Array<{
    kind: string;
    toolName?: string;
    resultJson?: {
      verificationFailure?: {
        code?: string;
        stage?: string;
        issues?: Array<{ message?: string }>;
      } | null;
    };
  }>;
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

async function writeProjectFile(
  page: Page,
  input: {
    projectId: string;
    path: string;
    content: string;
    expectedRevision: number;
  },
): Promise<number> {
  const response = await page.request.post(
    `/api/projects/${input.projectId}/files`,
    {
      data: {
        path: input.path,
        content: input.content,
        expectedRevision: input.expectedRevision,
      },
    },
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { revision: number } };
  return body.result.revision;
}

async function readAgentSnapshot(
  page: Page,
  projectId: string,
  conversationId: string,
): Promise<AgentSnapshot> {
  const response = await page.request.get(
    `/api/projects/${projectId}/agent?conversationId=${conversationId}`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { snapshot: AgentSnapshot | null };
  if (!body.snapshot) {
    throw new Error("Agent Conversation 快照不存在。");
  }
  return body.snapshot;
}

async function waitForRunStatus(
  page: Page,
  runId: string,
  status: string,
  timeout = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const response = await page.request.get(`/api/agent-runs/${runId}`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { run: Run };

    if (body.run.status === status) {
      return;
    }

    // 目标状态之前若已经进入其他终态，应立即暴露真实错误，避免把 Provider
    // 或状态机失败伪装成一个耗时数分钟的等待超时。
    if (TERMINAL_STATUSES.has(body.run.status)) {
      throw new Error(
        `Run 提前进入 ${body.run.status}：${body.run.errorMessage ?? "无错误详情"}`,
      );
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`等待 Run 进入 ${status} 超时。`);
}

test.describe("Agent workspace live flow", () => {
  test.skip(
    !AGENT_E2E_ENABLED,
    "设置 RUN_AGENT_E2E=1，并配置 LLM_PROVIDER、LLM_API_KEY、AGENT_ENABLED 后运行真实 Agent E2E。",
  );

  test("completes a natural-language edit and restores the conversation after refresh", async ({
    page,
  }) => {
    // 真实链路包含 DeepSeek 多轮调用与浏览器内首次 npm install。测试预算需要
    // 高于 Runtime 自身的 180 秒安装超时，避免网络慢时由测试先行中断。
    test.setTimeout(360_000);
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
    const run = await waitForTerminalRun(page, runBody.run.id, 300_000);

    expect(run.status, run.errorMessage ?? "Agent Run 未成功完成。").toBe(
      "succeeded",
    );
    expect(run.currentRevision).toBeGreaterThan(project.revision);

    const agentSnapshotResponse = await page.request.get(
      `/api/projects/${project.id}/agent?conversationId=${run.conversationId}`,
    );
    expect(agentSnapshotResponse.ok()).toBe(true);
    const agentSnapshotBody = (await agentSnapshotResponse.json()) as {
      snapshot: { tools: ToolInvocation[] } | null;
    };
    const previewInvocations =
      agentSnapshotBody.snapshot?.tools.filter(
        (tool) => tool.runId === run.id && tool.toolName === "run_preview",
      ) ?? [];
    const finalPreviewInvocation = previewInvocations.at(-1);

    // Agent 最终 succeeded 只代表它完成了本轮决策，不能替代浏览器运行事实。
    // Tool Ledger 按 createdAt 升序返回；模型可能根据失败证据主动重试，因此必须验证
    // 最后一次 run_preview，而不是把已经被后续成功验证取代的首次失败当成最终结果。
    expect(previewInvocations.length).toBeGreaterThan(0);
    expect(finalPreviewInvocation).toMatchObject({
      status: "succeeded",
      resultJson: {
        ok: true,
        build: { errors: [] },
        runtime: { rendered: true },
      },
    });

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
    await expect(
      page.getByRole("article").filter({ hasText: prompt }),
    ).toBeVisible();
    await expect(page.getByText("已完成", { exact: true })).toBeVisible();
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

  test("collects a button TypeError, repairs it and verifies the repaired revision", async ({
    page,
  }) => {
    test.setTimeout(480_000);
    const project = await createProject(page, "M3 TypeError repair");
    const brokenRevision = await writeProjectFile(page, {
      projectId: project.id,
      path: "src/index.tsx",
      expectedRevision: project.revision,
      content: `import { createRoot } from "react-dom/client";

function App() {
  function handleClick() {
    const selected = JSON.parse("null") as { label: string };
    document.title = selected.label;
  }

  return <button onClick={handleClick}>Trigger TypeError</button>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    });
    await page.goto(`/p/${project.id}`);
    const prompt = [
      `当前 revision 是 ${brokenRevision}。`,
      "这是运行时证据测试：第一步不要读取或修改文件，必须直接调用 run_preview 验证当前 revision。",
      "等待我点击 Trigger TypeError 按钮后，根据返回的结构化 Runtime/Console 证据定位并修复 TypeError。",
      "修复后重新 run_preview，只有最新 revision 验证成功才能结束。",
    ].join("");
    await page.getByLabel("给 Agent 的消息").fill(prompt);
    await page.getByRole("button", { name: "发送消息" }).click();

    const runResponse = await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/agent-runs") &&
        response.request().method() === "POST",
    );
    const runBody = (await runResponse.json()) as { run: Run };
    await waitForRunStatus(page, runBody.run.id, "awaiting_client_tool");

    const previewFrame = page.frameLocator(
      'iframe[title="WebContainer 项目预览"]',
    );
    await expect(
      previewFrame.locator('script[src*="/__webpilot/runtime-bridge-"]'),
    ).toHaveCount(1, { timeout: 180_000 });
    await previewFrame
      .getByRole("button", { name: "Trigger TypeError" })
      .click();

    await expect
      .poll(
        async () => {
          const snapshot = await readAgentSnapshot(
            page,
            project.id,
            runBody.run.conversationId,
          );
          return snapshot.tools.some(
            (tool) =>
              tool.runId === runBody.run.id &&
              tool.toolName === "run_preview" &&
              tool.resultJson?.ok === false &&
              tool.resultJson.runtime?.events?.some(
                (event) =>
                  event.type === "RUNTIME_ERROR" &&
                  event.message?.includes("label"),
              ),
          );
        },
        { timeout: 180_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true);

    const run = await waitForTerminalRun(page, runBody.run.id, 360_000);
    expect(run.status, run.errorMessage ?? "TypeError 未完成自动修复。").toBe(
      "succeeded",
    );
    expect(run.currentRevision).toBeGreaterThan(brokenRevision);
    expect(run.usage).toMatchObject({
      clientResumes: expect.any(Number),
      repairRounds: expect.any(Number),
      latestVerificationRevision: run.currentRevision,
      latestVerificationOk: true,
    });
    expect(run.usage?.clientResumes ?? 0).toBeGreaterThanOrEqual(2);
    expect(run.usage?.repairRounds ?? 0).toBeGreaterThanOrEqual(1);

    const snapshot = await readAgentSnapshot(
      page,
      project.id,
      run.conversationId,
    );
    const previews = snapshot.tools.filter(
      (tool) =>
        tool.runId === run.id &&
        tool.toolName === "run_preview" &&
        tool.resultJson,
    );
    expect(previews[0]?.resultJson).toMatchObject({
      ok: false,
      runtime: {
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "RUNTIME_ERROR",
            message: expect.stringContaining("label"),
          }),
        ]),
      },
    });
    expect(previews.at(-1)).toMatchObject({
      status: "succeeded",
      resultJson: {
        ok: true,
        runtime: { rendered: true },
      },
    });
  });

  test("returns structured install evidence instead of a generic failure", async ({
    page,
  }) => {
    test.setTimeout(360_000);
    const project = await createProject(page, "M3 install evidence");
    const packageResponse = await page.request.get(
      `/api/projects/${project.id}/files/package.json`,
    );
    expect(packageResponse.ok()).toBe(true);
    const packageBody = (await packageResponse.json()) as {
      file: { content: string };
    };
    const packageJson = JSON.parse(packageBody.file.content) as {
      dependencies: Record<string, string>;
    };
    packageJson.dependencies["webpilot-missing-package-m3"] = "999.0.0";
    const brokenRevision = await writeProjectFile(page, {
      projectId: project.id,
      path: "package.json",
      expectedRevision: project.revision,
      content: `${JSON.stringify(packageJson, null, 2)}\n`,
    });
    await page.goto(`/p/${project.id}`);
    const prompt = [
      `当前 revision 是 ${brokenRevision}。`,
      "第一步不要读取或修改文件，直接调用 run_preview。",
      "这是 install evidence 测试，收到安装失败结果后不要用泛化文本代替结构化证据。",
    ].join("");
    await page.getByLabel("给 Agent 的消息").fill(prompt);
    await page.getByRole("button", { name: "发送消息" }).click();
    const runResponse = await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/agent-runs") &&
        response.request().method() === "POST",
    );
    const runBody = (await runResponse.json()) as { run: Run };

    await expect
      .poll(
        async () => {
          const snapshot = await readAgentSnapshot(
            page,
            project.id,
            runBody.run.conversationId,
          );
          const result = snapshot.transcript.find(
            (message) =>
              message.kind === "tool_result" &&
              message.toolName === "run_preview" &&
              message.resultJson?.verificationFailure?.code ===
                "install_failed",
          );
          const failure = result?.resultJson?.verificationFailure;

          if (!failure) {
            return null;
          }

          // 安装器会同时返回进程摘要和 npm 原始错误行；验收重点是结构完整，
          // 且至少保留一条可定位到具体包或状态码的错误，而不是依赖数组顺序。
          return {
            code: failure.code,
            stage: failure.stage,
            hasSpecificInstallIssue:
              Array.isArray(failure.issues) &&
              failure.issues.some(
                (issue) =>
                  typeof issue === "object" &&
                  issue !== null &&
                  "message" in issue &&
                  typeof issue.message === "string" &&
                  /404|not found|matching version/i.test(issue.message),
              ),
          };
        },
        { timeout: 240_000, intervals: [1_000, 2_000] },
      )
      .toEqual({
        code: "install_failed",
        stage: "install",
        hasSpecificInstallIssue: true,
      });

    await page.request.post(`/api/agent-runs/${runBody.run.id}/cancel`);
    const cancelled = await waitForTerminalRun(page, runBody.run.id);
    expect(cancelled.status).toBe("cancelled");
  });

  test("keeps a cancelled Run terminal when a late Preview result arrives", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const project = await createProject(page, "M3 late preview cancellation");
    await page.goto(`/p/${project.id}`);
    const prompt = [
      `第一步直接调用 run_preview 验证 revision ${project.revision}，`,
      "observationMs 必须设置为 10000；在结果返回前不要执行其他工具。",
    ].join("");
    await page.getByLabel("给 Agent 的消息").fill(prompt);
    await page.getByRole("button", { name: "发送消息" }).click();
    const runResponse = await page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/agent-runs") &&
        response.request().method() === "POST",
    );
    const runBody = (await runResponse.json()) as { run: Run };
    await waitForRunStatus(page, runBody.run.id, "awaiting_client_tool");

    const cancelResponse = await page.request.post(
      `/api/agent-runs/${runBody.run.id}/cancel`,
    );
    expect(cancelResponse.ok()).toBe(true);
    await expect
      .poll(
        async () => {
          const snapshot = await readAgentSnapshot(
            page,
            project.id,
            runBody.run.conversationId,
          );
          return snapshot.events.some(
            (event) =>
              event.type === "client_tool.result_ignored" &&
              event.payload.reason === "run_not_awaiting_client_tool",
          );
        },
        { timeout: 180_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true);

    const finalRun = await waitForTerminalRun(page, runBody.run.id);
    expect(finalRun.status).toBe("cancelled");
    expect(finalRun.currentRevision).toBe(project.revision);
  });
});
