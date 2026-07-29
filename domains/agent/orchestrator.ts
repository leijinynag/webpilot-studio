import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  AGENT_ERROR_CODES,
  AgentError,
  isAgentError,
} from "@/domains/agent/errors";
import {
  RUN_PREVIEW_TOOL_NAME,
  runPreviewToolArgumentsSchema,
} from "@/domains/agent/evidence";
import type {
  FileToolExecutor,
  FileToolResultEnvelope,
} from "@/domains/agent/file-tools";
import { assertFrozenProfilesAvailable } from "@/domains/agent/profiles";
import type { LlmProvider, ProviderEvent } from "@/domains/agent/provider";
import type { ProviderFinishReason } from "@/domains/agent/provider";
import type { AgentStore } from "@/domains/agent/store";
import { assembleProviderMessages } from "@/domains/agent/transcript";
import {
  FILE_TOOL_NAMES,
  type FileToolName,
} from "@/domains/agent/tool-contracts";
import type {
  AgentRunRecord,
  AgentRunStatus,
  TranscriptMessage,
} from "@/domains/agent/types";
import {
  buildVerificationDirective,
  getPreviewVerificationState,
} from "@/domains/agent/verification";

type AgentStorePort = Pick<
  AgentStore<PgQueryResultHKT>,
  | "appendEvent"
  | "appendTranscript"
  | "claimExecution"
  | "registerToolInvocation"
  | "markToolInvocationRunning"
  | "getRun"
  | "listTranscript"
  | "releaseExecutionLease"
  | "renewExecutionLease"
  | "transitionRun"
  | "updateRunProgress"
>;

type FileToolExecutorPort = Pick<FileToolExecutor, "execute">;

type AccumulatedToolCall = {
  index: number;
  id: string;
  name: string;
  argumentsText: string;
};

export class AgentOrchestrator {
  constructor(
    private readonly store: AgentStorePort,
    private readonly provider: LlmProvider,
    private readonly fileTools: FileToolExecutorPort,
  ) {}

  async run(input: {
    ownerId: string;
    runId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const leaseId = await this.store.claimExecution({
      ownerId: input.ownerId,
      runId: input.runId,
    });

    if (!leaseId) {
      return;
    }

    try {
      let run = await this.store.getRun(input);
      const profiles = assertFrozenProfilesAvailable({
        promptProfile: run.promptProfile,
        promptDigest: run.promptDigest,
        toolsetProfile: run.toolsetProfile,
        toolsetDigest: run.toolsetDigest,
        promptContext: {
          locale: run.locale,
          projectId: run.projectId,
          revision: run.startRevision,
          repositoryCapability: run.repositoryCapability,
        },
      });

      if (run.cancellationRequestedAt) {
        await this.finishRun(run, "cancelled", AGENT_ERROR_CODES.cancelled);
        return;
      }

      if (run.status === "queued") {
        run = await this.store.transitionRun({
          ownerId: run.ownerId,
          runId: run.id,
          status: "running",
        });
      } else if (run.status !== "running") {
        // 等待浏览器工具时由 SSE/Conversation 快照恢复请求，服务端 Loop 不应
        // 抢跑或把一个健康的 awaiting 状态误判成失败。
        if (run.status === "awaiting_client_tool") {
          return;
        }

        throw new AgentError(
          AGENT_ERROR_CODES.runConflict,
          `当前 Run 状态 ${run.status} 不能由服务端 Agent Loop 推进。`,
          409,
        );
      }

      const startedAt = run.startedAt?.getTime() ?? Date.now();

      while (run.usage.modelTurns < run.budget.maxModelTurns) {
        assertWithinWallTime(run, startedAt);
        await this.assertNotCancelled(run, input.signal);
        await this.store.renewExecutionLease({
          ownerId: run.ownerId,
          runId: run.id,
          leaseId,
        });
        await this.store.appendEvent({
          runId: run.id,
          type: "run.progress",
          payload: {
            phase: "model",
            turn: run.usage.modelTurns + 1,
            currentRevision: run.currentRevision,
          },
        });

        const transcript = await this.store.listTranscript({
          ownerId: run.ownerId,
          conversationId: run.conversationId,
        });
        const turn = await this.streamModelTurn({
          run,
          transcript,
          systemPrompt: [
            profiles.prompt.content,
            buildVerificationDirective(run, transcript),
          ].join("\n\n"),
          tools: profiles.toolset.tools,
          signal: input.signal,
        });
        const nextUsage = {
          ...run.usage,
          modelTurns: run.usage.modelTurns + 1,
          inputTokens: run.usage.inputTokens + turn.inputTokens,
          outputTokens: run.usage.outputTokens + turn.outputTokens,
        };
        run = await this.store.updateRunProgress({
          ownerId: run.ownerId,
          runId: run.id,
          usage: nextUsage,
        });

        assertCompleteModelTurn(turn);

        if (turn.assistantText) {
          await this.store.appendTranscript({
            conversationId: run.conversationId,
            runId: run.id,
            role: "assistant",
            kind: "assistant_message",
            content: turn.assistantText,
          });
          await this.store.appendEvent({
            runId: run.id,
            type: "assistant.completed",
            payload: { characterCount: turn.assistantText.length },
          });
        }

        if (turn.finishReason === "length") {
          await this.finishRun(
            run,
            "budget_exhausted",
            AGENT_ERROR_CODES.budgetExhausted,
            "模型输出达到长度限制。",
          );
          return;
        }

        if (
          turn.finishReason === "content_filter" ||
          turn.finishReason === "provider_interrupted"
        ) {
          throw new AgentError(
            AGENT_ERROR_CODES.providerInterrupted,
            "模型未能正常完成当前轮次。",
            502,
            { finishReason: turn.finishReason },
          );
        }

        if (turn.toolCalls.length === 0) {
          const latestTranscript = await this.store.listTranscript({
            ownerId: run.ownerId,
            conversationId: run.conversationId,
          });
          const verification = getPreviewVerificationState(
            run,
            latestTranscript,
          );

          if (verification.ok) {
            await this.finishRun(run, "succeeded");
            return;
          }

          // Provider 可以生成“已经完成”之类的文本，但状态机只相信同 revision
          // 的 run_preview 成功证据。事件会让 UI 明确显示本轮被门禁拦下。
          await this.store.appendEvent({
            runId: run.id,
            type: "verification.completion_blocked",
            payload: {
              currentRevision: run.currentRevision,
              attempted: verification.attempted,
              previewRevision: verification.revision,
              ...(verification.failure
                ? { failure: verification.failure }
                : {}),
            },
          });
          continue;
        }

        enforceOneMutationPerTurn(turn.toolCalls);

        for (const toolCall of turn.toolCalls.sort(
          (left, right) => left.index - right.index,
        )) {
          await this.assertNotCancelled(run, input.signal);
          const argumentsJson = parseToolArguments(toolCall.argumentsText);
          const transcriptArguments = asTranscriptArguments(
            argumentsJson,
            toolCall.argumentsText,
          );
          await this.store.appendTranscript({
            conversationId: run.conversationId,
            runId: run.id,
            role: "assistant",
            kind: "tool_call",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            argumentsJson: transcriptArguments,
          });
          await this.store.appendEvent({
            runId: run.id,
            type: "tool.started",
            payload: {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              revision: run.currentRevision,
            },
          });

          if (toolCall.name === RUN_PREVIEW_TOOL_NAME) {
            await this.suspendForRunPreview({
              run,
              toolCall,
              argumentsJson,
              leaseId,
            });
            return;
          }

          if (isFileMutationTool(toolCall.name)) {
            if (run.usage.fileMutations >= run.budget.maxFileMutations) {
              throw new AgentError(
                AGENT_ERROR_CODES.budgetExhausted,
                "Agent 已达到文件 mutation 次数上限。",
                409,
              );
            }

            // mutation 预算在副作用前消费。即使参数或 Repository 操作失败，
            // 这次有风险的写操作尝试仍属于本 Run 的资源使用。
            run = await this.store.updateRunProgress({
              ownerId: run.ownerId,
              runId: run.id,
              usage: {
                ...run.usage,
                fileMutations: run.usage.fileMutations + 1,
              },
            });
          }

          const result = await this.fileTools.execute({
            run,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            argumentsJson,
          });
          await this.persistToolResult(run, toolCall, result);

          if (!result.ok && result.conflict) {
            const actualRevision = getConflictRevision(result.error.details);
            if (
              actualRevision !== null &&
              actualRevision > run.currentRevision
            ) {
              run = await this.store.updateRunProgress({
                ownerId: run.ownerId,
                runId: run.id,
                currentRevision: actualRevision,
              });
            }
            await this.finishRun(
              run,
              "conflicted",
              AGENT_ERROR_CODES.revisionConflict,
              result.error.message,
            );
            return;
          }

          if (!result.ok && result.error.code === AGENT_ERROR_CODES.cancelled) {
            await this.finishRun(
              run,
              "cancelled",
              AGENT_ERROR_CODES.cancelled,
              result.error.message,
            );
            return;
          }

          if (result.ok && result.revision !== run.currentRevision) {
            run = await this.store.updateRunProgress({
              ownerId: run.ownerId,
              runId: run.id,
              currentRevision: result.revision,
            });
          }
        }

        run = await this.store.getRun({
          ownerId: run.ownerId,
          runId: run.id,
        });
      }

      await this.finishRun(
        run,
        "budget_exhausted",
        AGENT_ERROR_CODES.budgetExhausted,
        "Agent 已达到最大模型轮次。",
      );
    } catch (error) {
      await this.handleTerminalError(input, error);
    } finally {
      await this.store.releaseExecutionLease({
        ownerId: input.ownerId,
        runId: input.runId,
        leaseId,
      });
    }
  }

  private async streamModelTurn(input: {
    run: AgentRunRecord;
    transcript: readonly TranscriptMessage[];
    systemPrompt: string;
    tools: readonly {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
    signal?: AbortSignal;
  }) {
    let assistantText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: ProviderFinishReason | null = null;
    const toolCalls = new Map<number, AccumulatedToolCall>();

    for await (const event of this.provider.streamTurn({
      model: input.run.model,
      messages: assembleProviderMessages(input.transcript, {
        systemPrompt: input.systemPrompt,
        maxMessageCharacters: input.run.budget.maxToolResultCharacters,
      }),
      tools: input.tools,
      maxOutputTokens: Math.max(
        256,
        Math.ceil(input.run.budget.maxOutputCharacters / 4),
      ),
      userId: input.run.ownerId,
      signal: input.signal,
    })) {
      switch (event.type) {
        case "text_delta":
          assistantText += event.text;
          if (assistantText.length > input.run.budget.maxOutputCharacters) {
            throw new AgentError(
              AGENT_ERROR_CODES.budgetExhausted,
              "模型输出超过字符预算。",
              409,
            );
          }
          await this.store.appendEvent({
            runId: input.run.id,
            type: "assistant.delta",
            payload: { text: event.text },
          });
          break;
        case "tool_call_delta":
          accumulateToolCall(toolCalls, event);
          break;
        case "usage":
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          await this.store.appendEvent({
            runId: input.run.id,
            type: "model.usage",
            payload: event,
          });
          break;
        case "finish":
          finishReason = event.reason;
          await this.store.appendEvent({
            runId: input.run.id,
            type: "model.finished",
            payload: { reason: event.reason },
          });
          break;
      }
    }

    return {
      assistantText,
      toolCalls: [...toolCalls.values()],
      inputTokens,
      outputTokens,
      finishReason,
    };
  }

  private async persistToolResult(
    run: AgentRunRecord,
    toolCall: AccumulatedToolCall,
    result: FileToolResultEnvelope,
  ) {
    await this.store.appendTranscript({
      conversationId: run.conversationId,
      runId: run.id,
      role: "tool",
      kind: "tool_result",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      resultJson: result,
    });
    await this.store.appendEvent({
      runId: run.id,
      type: "tool.completed",
      payload: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ok: result.ok,
        revision: result.ok ? result.revision : run.currentRevision,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      },
    });
  }

  private async suspendForRunPreview(input: {
    run: AgentRunRecord;
    toolCall: AccumulatedToolCall;
    argumentsJson: unknown;
    leaseId: string;
  }): Promise<void> {
    const argumentsResult = runPreviewToolArgumentsSchema.safeParse(
      input.argumentsJson,
    );

    if (!argumentsResult.success) {
      throw new AgentError(
        AGENT_ERROR_CODES.toolInvalidArguments,
        "工具 run_preview 的参数不合法。",
        400,
        { issues: argumentsResult.error.issues },
      );
    }

    if (argumentsResult.data.revision !== input.run.currentRevision) {
      throw new AgentError(
        AGENT_ERROR_CODES.revisionConflict,
        "run_preview 必须验证 Agent 当前持有的最新 revision。",
        409,
        {
          requestedRevision: argumentsResult.data.revision,
          currentRevision: input.run.currentRevision,
        },
      );
    }

    if (input.run.usage.clientResumes >= input.run.budget.maxClientResumes) {
      throw new AgentError(
        AGENT_ERROR_CODES.budgetExhausted,
        "Agent 已达到浏览器验证恢复次数上限。",
        409,
      );
    }

    const idempotencyKey = `${input.run.id}:${input.toolCall.id}`;
    const registration = await this.store.registerToolInvocation({
      runId: input.run.id,
      toolCallId: input.toolCall.id,
      toolName: RUN_PREVIEW_TOOL_NAME,
      executionDomain: "client",
      argumentsJson: argumentsResult.data,
      idempotencyKey,
      revisionBefore: input.run.currentRevision,
    });

    if (!registration.created) {
      throw new AgentError(
        AGENT_ERROR_CODES.toolAlreadyExecuted,
        "重复的 run_preview Tool Call 不能再次下发浏览器。",
        409,
        { toolCallId: input.toolCall.id },
      );
    }

    await this.store.markToolInvocationRunning({
      runId: input.run.id,
      toolCallId: input.toolCall.id,
    });
    await this.store.transitionRun({
      ownerId: input.run.ownerId,
      runId: input.run.id,
      status: "awaiting_client_tool",
    });

    // 必须在发布 SSE 请求前释放服务端租约。浏览器可能立即完成验证，
    // 若旧租约仍存在，结果接口恢复 Agent Loop 时会拿不到执行权。
    await this.store.releaseExecutionLease({
      ownerId: input.run.ownerId,
      runId: input.run.id,
      leaseId: input.leaseId,
    });
    await this.store.appendEvent({
      runId: input.run.id,
      type: "client_tool.requested",
      payload: {
        runId: input.run.id,
        projectId: input.run.projectId,
        toolCallId: input.toolCall.id,
        toolName: RUN_PREVIEW_TOOL_NAME,
        idempotencyKey,
        revision: input.run.currentRevision,
        arguments: argumentsResult.data,
      },
    });
  }

  private async assertNotCancelled(
    run: AgentRunRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const latest = await this.store.getRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    if (
      signal?.aborted ||
      latest.cancellationRequestedAt ||
      latest.status === "cancelled"
    ) {
      throw new AgentError(
        AGENT_ERROR_CODES.cancelled,
        "Agent Run 已取消。",
        409,
      );
    }
  }

  private async finishRun(
    run: AgentRunRecord,
    status: Extract<
      AgentRunStatus,
      "succeeded" | "failed" | "cancelled" | "budget_exhausted" | "conflicted"
    >,
    errorCode?: string,
    errorMessage?: string,
  ) {
    const latest = await this.store.getRun({
      ownerId: run.ownerId,
      runId: run.id,
    });

    if (
      latest.status === "succeeded" ||
      latest.status === "failed" ||
      latest.status === "cancelled" ||
      latest.status === "budget_exhausted" ||
      latest.status === "conflicted"
    ) {
      return;
    }

    await this.store.transitionRun({
      ownerId: latest.ownerId,
      runId: latest.id,
      status,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
    });
  }

  private async handleTerminalError(
    input: { ownerId: string; runId: string },
    error: unknown,
  ) {
    const run = await this.store.getRun(input);

    if (
      run.status === "succeeded" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "budget_exhausted" ||
      run.status === "conflicted"
    ) {
      return;
    }

    // 取消 fence 先于当前实例 AbortController 写入。即使 Provider 把 abort
    // 表达成连接中断，数据库事实仍要求本 Run 进入 cancelled，而不是 failed。
    if (run.cancellationRequestedAt) {
      await this.finishRun(
        run,
        "cancelled",
        AGENT_ERROR_CODES.cancelled,
        "用户取消了 Agent Run。",
      );
      return;
    }

    if (isAgentError(error)) {
      if (error.code === AGENT_ERROR_CODES.cancelled) {
        await this.finishRun(run, "cancelled", error.code, error.message);
        return;
      }

      if (error.code === AGENT_ERROR_CODES.budgetExhausted) {
        await this.finishRun(
          run,
          "budget_exhausted",
          error.code,
          error.message,
        );
        return;
      }

      if (error.code === AGENT_ERROR_CODES.revisionConflict) {
        await this.finishRun(run, "conflicted", error.code, error.message);
        return;
      }

      await this.finishRun(run, "failed", error.code, error.message);
      return;
    }

    console.error("[agent-orchestrator]", error);
    await this.finishRun(
      run,
      "failed",
      "AGENT_INTERNAL_ERROR",
      "Agent 执行过程中发生未知错误。",
    );
  }
}

function accumulateToolCall(
  toolCalls: Map<number, AccumulatedToolCall>,
  event: Extract<ProviderEvent, { type: "tool_call_delta" }>,
) {
  const existing = toolCalls.get(event.index) ?? {
    index: event.index,
    id: "",
    name: "",
    argumentsText: "",
  };
  existing.id = event.toolCallId ?? existing.id;
  existing.name = event.toolName ?? existing.name;
  existing.argumentsText += event.argumentsDelta ?? "";
  toolCalls.set(event.index, existing);
}

function getConflictRevision(
  details: Record<string, unknown> | undefined,
): number | null {
  const actualRevision = details?.actualRevision;
  return typeof actualRevision === "number" && Number.isInteger(actualRevision)
    ? actualRevision
    : null;
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function asTranscriptArguments(
  parsed: unknown,
  raw: string,
): Record<string, unknown> {
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : { rawArguments: raw };
}

function enforceOneMutationPerTurn(
  toolCalls: readonly AccumulatedToolCall[],
): void {
  const mutationNames = new Set<FileToolName>([
    FILE_TOOL_NAMES.writeFile,
    FILE_TOOL_NAMES.deleteFile,
    FILE_TOOL_NAMES.renameFile,
  ]);
  const mutationCount = toolCalls.filter((toolCall) =>
    mutationNames.has(toolCall.name as FileToolName),
  ).length;

  if (mutationCount > 1) {
    throw new AgentError(
      AGENT_ERROR_CODES.toolInvalidArguments,
      "同一模型轮次最多只能执行一个文件 mutation。",
      409,
    );
  }
}

function isFileMutationTool(toolName: string): boolean {
  return (
    toolName === FILE_TOOL_NAMES.writeFile ||
    toolName === FILE_TOOL_NAMES.deleteFile ||
    toolName === FILE_TOOL_NAMES.renameFile
  );
}

function assertWithinWallTime(run: AgentRunRecord, startedAt: number): void {
  if (Date.now() - startedAt > run.budget.maxWallTimeSeconds * 1000) {
    throw new AgentError(
      AGENT_ERROR_CODES.budgetExhausted,
      "Agent 已达到最大运行时间。",
      409,
    );
  }
}

function assertCompleteModelTurn(turn: {
  finishReason: ProviderFinishReason | null;
  toolCalls: readonly AccumulatedToolCall[];
}): void {
  if (!turn.finishReason) {
    throw new AgentError(
      AGENT_ERROR_CODES.providerInvalidStream,
      "模型流缺少 finish reason。",
      502,
    );
  }

  for (const toolCall of turn.toolCalls) {
    if (!toolCall.id || !toolCall.name) {
      throw new AgentError(
        AGENT_ERROR_CODES.providerInvalidStream,
        "模型返回了不完整的 Tool Call。",
        502,
        { index: toolCall.index },
      );
    }
  }

  if ((turn.finishReason === "tool_calls") !== turn.toolCalls.length > 0) {
    throw new AgentError(
      AGENT_ERROR_CODES.providerInvalidStream,
      "模型 finish reason 与 Tool Call 内容不一致。",
      502,
      {
        finishReason: turn.finishReason,
        toolCallCount: turn.toolCalls.length,
      },
    );
  }
}
