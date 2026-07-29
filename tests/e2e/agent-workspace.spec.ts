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
    network?: {
      entries?: Array<{
        method?: string;
        status?: number | null;
        failed?: boolean;
        url?: { path?: string };
      }>;
    };
  } | null;
};

type VerificationChecks = {
  buildOk: boolean | null;
  runtimeOk: boolean | null;
  consoleOk: boolean | null;
  networkOk: boolean | null;
  actionsOk: boolean | null;
  assertionsOk: boolean | null;
  revisionOk: boolean | null;
};

type VerificationRun = VerificationChecks & {
  id: string;
  runId: string;
  revision: number;
  status: "pending" | "running" | "passed" | "failed";
  source: "agent" | "replay";
  replayCount: number;
  smokeSteps: Array<{ action?: string }>;
  failedStep: number | null;
  networkEvidence: {
    entries?: Array<{
      method?: string;
      status?: number | null;
      failed?: boolean;
      url?: { path?: string };
    }>;
  } | null;
};

type VerificationStep = {
  verificationRunId: string;
  stepIndex: number;
  action: string;
  status: "passed" | "failed";
  error: {
    code?: string;
    message?: string;
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
  verificationRuns: VerificationRun[];
  verificationSteps: VerificationStep[];
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

async function startAgentRunFromWorkspace(
  page: Page,
  prompt: string,
): Promise<Run> {
  await page.getByLabel("给 Agent 的消息").fill(prompt);
  const runResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/agent-runs") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "发送消息" }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.status()).toBe(201);
  const body = (await runResponse.json()) as { run: Run };
  return body.run;
}

async function waitForAgentSnapshot(
  page: Page,
  input: {
    projectId: string;
    conversationId: string;
    predicate: (snapshot: AgentSnapshot) => boolean;
    timeout?: number;
  },
): Promise<AgentSnapshot> {
  const deadline = Date.now() + (input.timeout ?? 180_000);
  let latestSnapshot: AgentSnapshot | null = null;

  while (Date.now() < deadline) {
    latestSnapshot = await readAgentSnapshot(
      page,
      input.projectId,
      input.conversationId,
    );
    if (input.predicate(latestSnapshot)) {
      return latestSnapshot;
    }
    await page.waitForTimeout(500);
  }

  const verificationSummary =
    latestSnapshot?.verificationRuns.map((verification) => ({
      revision: verification.revision,
      status: verification.status,
      source: verification.source,
      replayCount: verification.replayCount,
      failedStep: verification.failedStep,
    })) ?? [];
  throw new Error(
    `等待 Agent 持久化目标证据超时。最新 Verification：${JSON.stringify(verificationSummary)}`,
  );
}

function expectAllVerificationChecksPassed(
  verification: VerificationRun,
): void {
  expect(verification).toMatchObject({
    buildOk: true,
    runtimeOk: true,
    consoleOk: true,
    networkOk: true,
    actionsOk: true,
    assertionsOk: true,
    revisionOk: true,
  });
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
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

  test("repairs a form assertion failure and replays every original smoke step", async ({
    page,
  }) => {
    test.setTimeout(540_000);
    const project = await createProject(page, "M4 form assertion repair");
    const brokenRevision = await writeProjectFile(page, {
      projectId: project.id,
      path: "src/index.tsx",
      expectedRevision: project.revision,
      content: `import { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [name, setName] = useState("");
  const [message] = useState("尚未保存");

  return (
    <main>
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          姓名
          <input
            data-testid="name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button data-testid="save-button" type="submit">
          保存
        </button>
      </form>
      <p data-testid="success-message">{message}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    });
    await page.goto(`/p/${project.id}`);

    const prompt = [
      `当前 revision 是 ${brokenRevision}。这是 M4 固定验收案例。`,
      "第一步必须直接调用 browser_verify，不要先读文件或修改文件。",
      "smoke steps 必须依次为：",
      '1. fill test_id=name-input，value="Ada"；',
      "2. click test_id=save-button；",
      '3. assert_text test_id=success-message，text="保存成功：Ada"。',
      "不要配置 acceptedNetworkFailures。",
      "收到断言失败证据后，读取 src/index.tsx，只修复一次根因。",
      "修改后等待系统自动在新 revision 重放完全相同的三步；",
      "只有自动重放七项检查全部通过后才能结束。",
    ].join("");
    const createdRun = await startAgentRunFromWorkspace(page, prompt);
    const run = await waitForTerminalRun(page, createdRun.id, 480_000);

    expect(run.status, run.errorMessage ?? "表单行为错误未完成自动修复。").toBe(
      "succeeded",
    );
    expect(run.currentRevision).toBeGreaterThan(brokenRevision);
    expect(run.usage).toMatchObject({
      repairRounds: expect.any(Number),
      latestVerificationRevision: run.currentRevision,
      latestVerificationOk: true,
    });
    expect(run.usage?.repairRounds ?? 0).toBeGreaterThanOrEqual(1);

    const snapshot = await readAgentSnapshot(
      page,
      project.id,
      run.conversationId,
    );
    const verifications = snapshot.verificationRuns.filter(
      (verification) => verification.runId === run.id,
    );
    const initial = verifications.find(
      (verification) => verification.source === "agent",
    );
    const replay = verifications.find(
      (verification) =>
        verification.source === "replay" &&
        verification.revision === run.currentRevision &&
        verification.status === "passed",
    );

    expect(initial).toMatchObject({
      revision: brokenRevision,
      status: "failed",
      source: "agent",
      replayCount: 0,
      actionsOk: true,
      assertionsOk: false,
      failedStep: 2,
    });
    expect(replay).toBeDefined();
    expect(replay!.replayCount).toBeGreaterThanOrEqual(1);
    expect(replay!.smokeSteps).toEqual(initial!.smokeSteps);
    expect(replay!.smokeSteps.map((step) => step.action)).toEqual([
      "fill",
      "click",
      "assert_text",
    ]);
    expectAllVerificationChecksPassed(replay!);

    const replaySteps = snapshot.verificationSteps.filter(
      (step) => step.verificationRunId === replay!.id,
    );
    expect(replaySteps).toHaveLength(initial!.smokeSteps.length);
    expect(replaySteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stepIndex: 0, status: "passed" }),
        expect.objectContaining({ stepIndex: 1, status: "passed" }),
        expect.objectContaining({ stepIndex: 2, status: "passed" }),
      ]),
    );
  });

  test("captures a 500 response, repairs the API and passes browser replay", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const project = await createProject(page, "M4 API 500 repair");
    let revision = await writeProjectFile(page, {
      projectId: project.id,
      path: "src/index.tsx",
      expectedRevision: project.revision,
      content: `import { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("尚未保存");

  async function save() {
    const response = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    setMessage(response.ok ? "保存成功" : "保存失败");
  }

  return (
    <main>
      <input
        data-testid="title-input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button data-testid="save-button" type="button" onClick={save}>
        保存
      </button>
      <p data-testid="save-status">{message}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    });
    revision = await writeProjectFile(page, {
      projectId: project.id,
      path: "rsbuild.config.ts",
      expectedRevision: revision,
      content: `import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    template: "./index.html",
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    setup({ server }) {
      server.middlewares.use("/api/save", (_request, response) => {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "fixed M4 failure" }));
      });
    },
  },
});
`,
    });
    await page.goto(`/p/${project.id}`);

    const prompt = [
      `当前 revision 是 ${revision}。这是 M4 固定 Network evidence 验收案例。`,
      "第一步必须直接调用 browser_verify，不要先读或改文件。",
      "smoke steps 必须依次为：",
      '1. fill test_id=title-input，value="M4 report"；',
      "2. click test_id=save-button；",
      '3. assert_text test_id=save-status，text="保存成功"。',
      "不要接受或忽略任何网络失败。",
      "首次验证应捕获 POST /api/save 的 500；根据该 Network evidence 定位根因。",
      "修复后必须让系统自动重放原始三步，并且 Network 与其余六项检查全部通过。",
    ].join("");
    const createdRun = await startAgentRunFromWorkspace(page, prompt);
    const run = await waitForTerminalRun(page, createdRun.id, 540_000);

    expect(run.status, run.errorMessage ?? "API 500 未完成自动修复。").toBe(
      "succeeded",
    );
    expect(run.currentRevision).toBeGreaterThan(revision);
    expect(run.usage).toMatchObject({
      latestVerificationRevision: run.currentRevision,
      latestVerificationOk: true,
    });

    const snapshot = await readAgentSnapshot(
      page,
      project.id,
      run.conversationId,
    );
    const verifications = snapshot.verificationRuns.filter(
      (verification) => verification.runId === run.id,
    );
    const failedWith500 = verifications.find((verification) =>
      verification.networkEvidence?.entries?.some(
        (entry) =>
          entry.method === "POST" &&
          entry.url?.path === "/api/save" &&
          entry.status === 500 &&
          entry.failed === true,
      ),
    );
    const replay = verifications.find(
      (verification) =>
        verification.source === "replay" &&
        verification.revision === run.currentRevision &&
        verification.status === "passed",
    );

    expect(failedWith500).toMatchObject({
      status: "failed",
      networkOk: false,
    });
    expect(replay).toBeDefined();
    expect(replay!.replayCount).toBeGreaterThanOrEqual(1);
    expect(replay!.smokeSteps).toEqual(failedWith500!.smokeSteps);
    expectAllVerificationChecksPassed(replay!);
  });

  test("fails an ambiguous role-name target without clicking a random element", async ({
    page,
  }) => {
    test.setTimeout(360_000);
    const project = await createProject(page, "M4 ambiguous browser target");
    const revision = await writeProjectFile(page, {
      projectId: project.id,
      path: "src/index.tsx",
      expectedRevision: project.revision,
      content: `import { useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [message, setMessage] = useState("未操作");

  return (
    <main>
      <button type="button" onClick={() => setMessage("删除了第一项")}>
        删除
      </button>
      <button type="button" onClick={() => setMessage("删除了第二项")}>
        删除
      </button>
      <p data-testid="delete-status">{message}</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    });
    await page.goto(`/p/${project.id}`);

    const prompt = [
      `当前 revision 是 ${revision}。这是 M4 target ambiguity 验收，不需要修复代码。`,
      "第一步必须直接调用 browser_verify。",
      '第一步必须是 click，target 必须严格使用 {"strategy":"role_name","role":"button","name":"删除"}；',
      '第二步使用 assert_text test_id=delete-status，text="删除了第一项"。',
      "不要改用 test_id、CSS 或 scan_id，也不要在失败后修改文件。",
      "目标歧义时保留结构化失败并等待，不要随机选择任一按钮。",
    ].join("");
    const createdRun = await startAgentRunFromWorkspace(page, prompt);
    const snapshot = await waitForAgentSnapshot(page, {
      projectId: project.id,
      conversationId: createdRun.conversationId,
      timeout: 300_000,
      predicate: (current) =>
        current.verificationSteps.some(
          (step) =>
            step.action === "click" &&
            step.status === "failed" &&
            step.error?.code === "target_ambiguous" &&
            current.verificationRuns.some(
              (verification) =>
                verification.id === step.verificationRunId &&
                verification.runId === createdRun.id,
            ),
        ),
    });
    const ambiguousStep = snapshot.verificationSteps.find(
      (step) =>
        step.action === "click" &&
        step.status === "failed" &&
        step.error?.code === "target_ambiguous" &&
        snapshot.verificationRuns.some(
          (verification) =>
            verification.id === step.verificationRunId &&
            verification.runId === createdRun.id,
        ),
    );
    const verification = snapshot.verificationRuns.find(
      (item) => item.id === ambiguousStep?.verificationRunId,
    );

    expect(verification).toMatchObject({
      runId: createdRun.id,
      revision,
      status: "failed",
      actionsOk: false,
      assertionsOk: false,
      failedStep: 0,
    });
    expect(ambiguousStep).toMatchObject({
      stepIndex: 0,
      status: "failed",
      error: {
        code: "target_ambiguous",
        message: expect.stringContaining("2"),
      },
    });
    expect(
      snapshot.verificationSteps.some(
        (step) =>
          step.verificationRunId === verification?.id && step.stepIndex === 1,
      ),
    ).toBe(false);

    // 此案例的通过条件就是明确失败。Run 可能已恢复给模型，因此主动取消，
    // 避免它在下一轮违背夹具约束并尝试“修复”本来就故意重复的按钮。
    await page.request.post(`/api/agent-runs/${createdRun.id}/cancel`);
    const cancelled = await waitForTerminalRun(page, createdRun.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.currentRevision).toBe(revision);
  });

  test("rejects a successful browser result after the repository advances", async ({
    page,
  }) => {
    test.setTimeout(360_000);
    const project = await createProject(page, "M4 stale browser result");
    const revision = await writeProjectFile(page, {
      projectId: project.id,
      path: "src/index.tsx",
      expectedRevision: project.revision,
      content: `import { createRoot } from "react-dom/client";

function App() {
  return <h1 data-testid="revision-label">revision ${project.revision + 1}</h1>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    });
    await page.goto(`/p/${project.id}`);

    const interceptedResult = createDeferred<string>();
    const clientResultGate = createDeferred();

    // Browser 已在旧 revision 上完成成功验证，但先不让结果到达服务端。
    // 在请求闸门打开前推进 Repository，复现用户保存与客户端迟到结果的竞态。
    await page.route(
      "**/api/agent-runs/*/client-tool-results",
      async (route) => {
        const payload = route.request().postDataJSON() as {
          toolName?: string;
          revision?: number;
          result?: { ok?: boolean; verificationRunId?: string };
        };
        if (
          payload.toolName === "browser_verify" &&
          payload.revision === revision &&
          payload.result?.ok === true &&
          payload.result.verificationRunId
        ) {
          interceptedResult.resolve(payload.result.verificationRunId);
          await clientResultGate.promise;
        }
        await route.continue();
      },
    );

    const prompt = [
      `当前 revision 是 ${revision}。第一步直接调用 browser_verify，不要读取或修改文件。`,
      `只执行 assert_text test_id=revision-label，text="revision ${revision}"。`,
      "验证成功后不要调用其他工具。",
    ].join("");
    const createdRun = await startAgentRunFromWorkspace(page, prompt);
    const staleVerificationRunId = await interceptedResult.promise;

    const newerRevision = await writeProjectFile(page, {
      projectId: project.id,
      path: "src/index.tsx",
      expectedRevision: revision,
      content: `import { createRoot } from "react-dom/client";

function App() {
  return <h1 data-testid="revision-label">revision ${revision + 1}</h1>;
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    });
    expect(newerRevision).toBe(revision + 1);
    clientResultGate.resolve();

    const snapshot = await waitForAgentSnapshot(page, {
      projectId: project.id,
      conversationId: createdRun.conversationId,
      predicate: (current) =>
        current.events.some(
          (event) =>
            event.type === "client_tool.result_ignored" &&
            event.payload.reason === "stale_revision" &&
            event.payload.repositoryRevision === newerRevision,
        ),
    });
    const staleVerification = snapshot.verificationRuns.find(
      (verification) => verification.id === staleVerificationRunId,
    );
    const ignoredEvent = snapshot.events.find(
      (event) =>
        event.type === "client_tool.result_ignored" &&
        event.payload.reason === "stale_revision",
    );

    expect(staleVerification).toMatchObject({
      runId: createdRun.id,
      revision,
      status: "running",
      revisionOk: null,
    });
    expect(ignoredEvent?.payload).toMatchObject({
      submittedRevision: revision,
      currentRevision: revision,
      repositoryRevision: newerRevision,
    });

    const waitingRunResponse = await page.request.get(
      `/api/agent-runs/${createdRun.id}`,
    );
    const waitingRunBody = (await waitingRunResponse.json()) as { run: Run };
    expect(waitingRunBody.run).toMatchObject({
      status: "awaiting_client_tool",
      currentRevision: revision,
      usage: {
        latestVerificationRevision: null,
        latestVerificationOk: null,
      },
    });

    await page.request.post(`/api/agent-runs/${createdRun.id}/cancel`);
    const cancelled = await waitForTerminalRun(page, createdRun.id);
    expect(cancelled.status).toBe("cancelled");
  });
});
