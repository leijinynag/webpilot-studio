import "server-only";

import { AGENT_ERROR_CODES, isAgentError } from "@/domains/agent/errors";
import { AgentOrchestrator } from "@/domains/agent/orchestrator";
import { FileToolExecutor } from "@/domains/agent/file-tools";
import { withAgentRunController } from "@/infrastructure/agent/run-controller";
import { getAgentProviderRuntime } from "@/infrastructure/agent/provider-factory";
import { getAgentPersistence } from "@/infrastructure/http/agent-api";

export async function launchAgentRun(input: {
  ownerId: string;
  runId: string;
}): Promise<void> {
  const { store, repository } = getAgentPersistence();

  try {
    const { provider } = getAgentProviderRuntime();
    const orchestrator = new AgentOrchestrator(
      store,
      provider,
      new FileToolExecutor(repository, store),
    );

    await withAgentRunController(input.runId, (signal) =>
      orchestrator.run({ ...input, signal }),
    );
  } catch (error) {
    const run = await store.getRun(input);

    if (
      run.status === "queued" ||
      run.status === "running" ||
      run.status === "awaiting_client_tool" ||
      run.status === "awaiting_async_job"
    ) {
      await store.transitionRun({
        ownerId: input.ownerId,
        runId: input.runId,
        status: "failed",
        errorCode: isAgentError(error)
          ? error.code
          : AGENT_ERROR_CODES.providerInterrupted,
        errorMessage: isAgentError(error)
          ? error.message
          : "Agent 执行器启动失败。",
      });
    }

    console.error("[agent-runtime]", error);
  }
}
