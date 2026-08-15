import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import {
  AGENT_ERROR_CODES,
  AgentError,
  isAgentError,
  isAgentBudgetErrorCode,
  serializeAgentError,
} from "@/domains/agent/errors";
import {
  BROWSER_VERIFY_TOOL_NAME,
  browserVerifyToolArgumentsSchema,
} from "@/domains/agent/client-tools";
import {
  RUN_PREVIEW_TOOL_NAME,
  runPreviewToolArgumentsSchema,
} from "@/domains/agent/evidence";
import type {
  FileToolExecutor,
  FileToolResultEnvelope,
} from "@/domains/agent/file-tools";
import type {
  VisionToolExecutor,
  VisionToolResultEnvelope,
} from "@/domains/agent/vision-tools";
import type {
  AssetToolExecutor,
  AssetToolResultEnvelope,
} from "@/domains/image/asset-tool";
import { assertFrozenProfilesAvailable } from "@/domains/agent/profiles";
import { normalizeRepositoryIntent } from "@/domains/agent/repository-intent";
import type { ImageToolResultEnvelope } from "@/domains/agent/image-tools";
import type { LlmProvider, ProviderEvent } from "@/domains/agent/provider";
import type { ProviderFinishReason } from "@/domains/agent/provider";
import type { AgentStore } from "@/domains/agent/store";
import { assembleProviderMessages } from "@/domains/agent/transcript";
import {
  ensureContextCheckpoint,
  type ContextCheckpointStore,
} from "@/domains/agent/context-checkpoint";
import {
  FILE_TOOL_NAMES,
  FILE_TOOL_SCHEMAS,
  GIT_TOOL_NAMES,
  GIT_TOOL_SCHEMAS,
  type FileToolName,
  type GitToolName,
} from "@/domains/agent/tool-contracts";
import { INSPECT_ATTACHMENT_TOOL_NAME } from "@/domains/image/vision-tool";
import { GENERATE_IMAGE_TOOL_NAME } from "@/domains/image/generation-tool";
import { LIST_PROJECT_ASSETS_TOOL_NAME } from "@/domains/image/asset-tool-definition";
import type { ImageToolExecutor } from "@/domains/agent/image-tools";
import { isImageError } from "@/domains/image/errors";
import type { AttachmentContextResolver } from "@/infrastructure/agent/attachment-context";
import type {
  recordModelUsage,
  reserveModelUsageBudget,
  settleModelUsageBudget,
  UsageBudgetReservation,
} from "@/infrastructure/quota/service";
import type {
  AgentRunRecord,
  AgentRunStatus,
  TranscriptMessage,
} from "@/domains/agent/types";
import {
  getActiveExecutionDurationMs,
  resumeAgentExecution,
} from "@/domains/agent/types";
import {
  buildAgentVerificationDirective,
  getAgentVerificationState,
} from "@/domains/agent/verification";

type AgentStorePort = Pick<
  AgentStore<PgQueryResultHKT>,
  | "appendEvent"
  | "appendTranscript"
  | "claimExecution"
  | "completeToolInvocation"
  | "completeSuccessfulRun"
  | "findReplayableSmokePlan"
  | "findSuccessfulRead"
  | "getLatestVerificationRun"
  | "getContextCheckpoint"
  | "hasPendingClientToolWait"
  | "registerToolInvocation"
  | "markToolInvocationRunning"
  | "getRun"
  | "listTranscript"
  | "recoverPendingClientToolWait"
  | "releaseExecutionLease"
  | "renewExecutionLease"
  | "suspendForClientTool"
  | "transitionRun"
  | "updateRunProgress"
  | "compareAndSetContextCheckpoint"
>;

type FileToolExecutorPort = Pick<FileToolExecutor, "execute">;
type VisionToolExecutorPort = Pick<VisionToolExecutor, "execute">;
type ImageToolExecutorPort = Pick<ImageToolExecutor, "suspend">;
type AgentToolResultEnvelope =
  | FileToolResultEnvelope
  | VisionToolResultEnvelope
  | AssetToolResultEnvelope
  | ImageToolResultEnvelope;

type AccumulatedToolCall = {
  index: number;
  id: string;
  name: string;
  argumentsText: string;
};

function estimateProviderInputTokens(
  messages: readonly {
    content?: unknown;
    name?: string;
    toolCallId?: string;
    toolCalls?: readonly unknown[];
  }[],
): number {
  // Provider 可能把图片、工具参数和系统提示分别计入 token。这里不追求
  // 账单级精确，而是用字符数加结构字段做调用前保守上限，最终仍以 Provider
  // 返回的 usage 结算。
  const serializedCharacters = messages.reduce((total, message) => {
    const contentCharacters =
      typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content ?? "").length;
    return (
      total +
      contentCharacters +
      (message.name?.length ?? 0) +
      (message.toolCallId?.length ?? 0) +
      JSON.stringify(message.toolCalls ?? "").length
    );
  }, 0);

  return Math.max(1, Math.ceil(serializedCharacters / 4));
}

const EXECUTION_LEASE_RENEW_INTERVAL_MS = 45_000;
const MAX_PARTIAL_PROVIDER_STREAM_RETRIES = 2;

export class AgentOrchestrator {
  constructor(
    private readonly store: AgentStorePort,
    private readonly provider: LlmProvider,
    private readonly fileTools: FileToolExecutorPort,
    private readonly visionTools?: VisionToolExecutorPort,
    private readonly imageTools?: ImageToolExecutorPort,
    private readonly assetTools?: Pick<AssetToolExecutor, "execute">,
    private readonly attachmentContextResolver?: AttachmentContextResolver,
    private readonly onModelUsage?: typeof recordModelUsage,
    private readonly reserveModelBudget?: typeof reserveModelUsageBudget,
    private readonly settleModelBudget?: typeof settleModelUsageBudget,
    private readonly checkpointRuntime?: {
      provider: LlmProvider;
      providerName: string;
      model: string;
      usage?: Parameters<typeof ensureContextCheckpoint>[0]["usage"];
    },
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
      } else if (run.status === "running") {
        // Provider 的 tool_call 必须与 tool_result 成对。若历史竞态留下
        // running + pending client Ledger，继续请求模型只会得到供应商 400；
        // 先恢复等待态，让客户端从 Conversation 快照重建并提交真实结果。
        const recoveredClientToolWait =
          await this.store.recoverPendingClientToolWait({
            ownerId: run.ownerId,
            runId: run.id,
            leaseId,
          });

        if (recoveredClientToolWait) {
          return;
        }

        // 历史 Run 可能早于 active execution 计时字段存在。恢复时从当前时刻
        // 开启新的服务端执行片段，绝不回退到 startedAt 计算整段自然时间。
        if (!run.usage.activeExecutionStartedAt) {
          run = await this.store.updateRunProgress({
            ownerId: run.ownerId,
            runId: run.id,
            usage: resumeAgentExecution(run.usage, new Date()),
          });
        }
      } else {
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

      let partialProviderStreamRetries = 0;
      let attachmentContexts = new Map<string, string>();

      modelLoop: while (
        run.budget.maxModelTurns === null ||
        run.usage.modelTurns < run.budget.maxModelTurns
      ) {
        assertWithinWallTime(run);
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
        if (
          run.usage.modelTurns === 0 &&
          this.hasRunAttachments(run, transcript)
        ) {
          if (!this.attachmentContextResolver) {
            throw new AgentError(
              AGENT_ERROR_CODES.providerNotConfigured,
              "当前 Agent 已收到图片，但服务端没有配置 Vision Provider。",
              503,
              { feature: "vision" },
            );
          }
          attachmentContexts = await this.attachmentContextResolver.resolve({
            run,
            transcript,
            signal: input.signal,
          });
        }
        const latestVerificationRun = await this.store.getLatestVerificationRun(
          {
            ownerId: run.ownerId,
            runId: run.id,
          },
        );
        const systemPrompt = [
          profiles.prompt.content,
          buildAgentVerificationDirective({
            run,
            transcript,
            latestVerificationRun,
          }),
        ].join("\n\n");
        const contextCheckpoint = this.checkpointRuntime
          ? await ensureContextCheckpoint({
              store: this.store as ContextCheckpointStore,
              provider: this.checkpointRuntime.provider,
              providerName: this.checkpointRuntime.providerName,
              model: this.checkpointRuntime.model,
              run,
              transcript,
              systemPrompt,
              signal: input.signal,
              usage: this.checkpointRuntime.usage,
            })
          : await this.store.getContextCheckpoint({
              ownerId: run.ownerId,
              conversationId: run.conversationId,
            });
        const turn = await this.streamModelTurn({
          run,
          transcript,
          systemPrompt,
          contextCheckpoint,
          tools: profiles.toolset.tools,
          attachmentContexts,
          leaseId,
          signal: input.signal,
        });
        const retryableEmptyToolCallTurn =
          !turn.interruption && isRetryableEmptyToolCallTurn(turn);
        const consecutiveEmptyToolCallTurns = retryableEmptyToolCallTurn
          ? run.usage.consecutiveEmptyToolCallTurns + 1
          : turn.interruption
            ? run.usage.consecutiveEmptyToolCallTurns
            : 0;
        const nextUsage = {
          ...run.usage,
          modelTurns: run.usage.modelTurns + 1,
          inputTokens: run.usage.inputTokens + turn.inputTokens,
          outputTokens: run.usage.outputTokens + turn.outputTokens,
          consecutiveEmptyToolCallTurns,
        };
        run = await this.store.updateRunProgress({
          ownerId: run.ownerId,
          runId: run.id,
          usage: nextUsage,
        });
        // 全局预算开启时，usage ledger 已经在 streamModelTurn 内完成预留和
        // 结算，不能再写一条兼容账本。未开启预算时才使用旧入口保留用量记录。
        if (!turn.budgetReservation) {
          await this.onModelUsage?.({
            ownerId: run.ownerId,
            agentRunId: run.id,
            provider: run.provider,
            model: run.model,
            turn: nextUsage.modelTurns,
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
          });
        }

        if (turn.interruption) {
          if (
            partialProviderStreamRetries >= MAX_PARTIAL_PROVIDER_STREAM_RETRIES
          ) {
            throw turn.interruption;
          }

          partialProviderStreamRetries += 1;
          await this.store.appendEvent({
            runId: run.id,
            type: "model.turn_retried",
            payload: {
              reason: "provider_stream_interrupted",
              errorCode: turn.interruption.code,
              discardedCharacterCount: turn.assistantText.length,
              discardedToolCallCount: turn.toolCalls.length,
              retryAttempt: partialProviderStreamRetries,
              maxRetryAttempts: MAX_PARTIAL_PROVIDER_STREAM_RETRIES,
              consumedModelTurns: run.usage.modelTurns,
            },
          });
          continue;
        }

        partialProviderStreamRetries = 0;

        // DeepSeek 偶发只返回 finish_reason=tool_calls，却没有发送任何
        // tool_call_delta。这类响应没有可执行副作用，也没有形成可持久化的
        // Assistant 消息，因此可以按同一 Transcript 重试。连续次数与用量
        // 一起持久化，实例重启或租约接管也不能绕过无进展熔断。
        if (retryableEmptyToolCallTurn) {
          await this.store.appendEvent({
            runId: run.id,
            type: "model.turn_retried",
            payload: {
              reason: "empty_tool_calls",
              discardedCharacterCount: turn.assistantText.length,
              consumedModelTurns: run.usage.modelTurns,
              consecutiveEmptyToolCallTurns:
                run.usage.consecutiveEmptyToolCallTurns,
              maxNoProgressRepeats: run.budget.maxNoProgressRepeats,
            },
          });

          if (
            run.usage.consecutiveEmptyToolCallTurns >=
            run.budget.maxNoProgressRepeats
          ) {
            await this.store.appendEvent({
              runId: run.id,
              type: "run.no_progress",
              payload: {
                reason: "consecutive_empty_tool_calls",
                consecutiveEmptyToolCallTurns:
                  run.usage.consecutiveEmptyToolCallTurns,
                maxNoProgressRepeats: run.budget.maxNoProgressRepeats,
                consumedModelTurns: run.usage.modelTurns,
              },
            });
            await this.finishRun(
              run,
              "budget_exhausted",
              AGENT_ERROR_CODES.noProgress,
              "模型连续返回空工具调用，Agent 已停止无进展循环，可发送“继续”恢复执行。",
            );
            return;
          }
          continue;
        }

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
            AGENT_ERROR_CODES.outputExhausted,
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
          const verification = getAgentVerificationState({
            run,
            transcript: latestTranscript,
            latestVerificationRun: await this.store.getLatestVerificationRun({
              ownerId: run.ownerId,
              runId: run.id,
            }),
          });

          // 只读请求不需要启动 WebContainer，也不应该被运行时验证门禁
          // 反复拦截。只有发生过文件 mutation，或模型主动发起过验证，
          // 才把验证结果作为本次 Run 的完成条件。
          if (run.usage.fileMutations === 0 && !verification.attempted) {
            await this.finishRun(run, "succeeded");
            return;
          }

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
            const suspended = await this.suspendForRunPreview({
              run,
              toolCall,
              argumentsJson,
              leaseId,
            });

            if (suspended) {
              return;
            }

            // 参数错误已经作为 tool_result 回喂模型。立即进入下一模型轮次，
            // 不继续执行同一批次中可能依赖非法调用的其他 Tool Call。
            continue modelLoop;
          }

          if (toolCall.name === BROWSER_VERIFY_TOOL_NAME) {
            const suspended = await this.suspendForBrowserVerify({
              run,
              toolCall,
              argumentsJson,
              leaseId,
              source: "agent",
              replayCount: 0,
            });

            if (suspended) {
              return;
            }

            continue modelLoop;
          }

          if (toolCall.name === INSPECT_ATTACHMENT_TOOL_NAME) {
            if (!this.visionTools) {
              await this.persistInvalidClientToolArguments({
                run,
                toolCall,
                message: "当前 Agent Runtime 没有配置 Vision 工具。",
                issues: [],
              });
              continue modelLoop;
            }
            const result = await this.visionTools.execute({
              run,
              toolCallId: toolCall.id,
              argumentsJson,
            });
            await this.persistToolResult(run, toolCall, result);
            continue modelLoop;
          }

          if (toolCall.name === LIST_PROJECT_ASSETS_TOOL_NAME) {
            if (!this.assetTools) {
              await this.persistInvalidClientToolArguments({
                run,
                toolCall,
                message: "当前 Agent Runtime 没有配置项目资产工具。",
                issues: [],
              });
              continue modelLoop;
            }
            const result = await this.assetTools.execute({
              run,
              toolCallId: toolCall.id,
              argumentsJson,
            });
            await this.persistToolResult(run, toolCall, result);
            continue modelLoop;
          }

          if (toolCall.name === GENERATE_IMAGE_TOOL_NAME) {
            const argumentsResult = parseImageToolArguments(argumentsJson);

            if (!argumentsResult.ok) {
              await this.persistInvalidClientToolArguments({
                run,
                toolCall,
                message: "工具 generate_image 的参数不合法。",
                issues: argumentsResult.issues,
              });
              continue modelLoop;
            }

            if (!this.imageTools) {
              await this.persistInvalidClientToolArguments({
                run,
                toolCall,
                message: "当前 Agent Runtime 没有配置图片生成工具。",
                issues: [],
              });
              continue modelLoop;
            }

            try {
              await this.imageTools.suspend({
                run,
                toolCallId: toolCall.id,
                argumentsJson: argumentsResult.data,
                leaseId,
              });
            } catch (error) {
              if (
                isImageError(error) &&
                error.code === "IMAGE_GENERATION_NOT_CONFIGURED"
              ) {
                await this.persistToolResult(run, toolCall, {
                  ok: false,
                  toolName: GENERATE_IMAGE_TOOL_NAME,
                  revision: run.currentRevision,
                  error: {
                    code: error.code,
                    message: error.message,
                    ...(error.details ? { details: error.details } : {}),
                  },
                });
                continue modelLoop;
              }
              throw error;
            }
            // suspendForImageGeneration 已经在同一事务中释放租约并切换
            // awaiting_async_job。当前执行片段必须立即结束，避免继续向
            // Provider 发送没有 tool_result 的下一轮请求。
            return;
          }

          if (
            run.repositoryCapability.storageKind === "browser_git" &&
            isBrowserRepositoryTool(toolCall.name)
          ) {
            if (isFileMutationTool(toolCall.name)) {
              if (run.usage.fileMutations >= run.budget.maxFileMutations) {
                throw new AgentError(
                  AGENT_ERROR_CODES.fileMutationsExhausted,
                  "Agent 已达到文件 mutation 次数上限。",
                  409,
                );
              }

              // Browser Git 的源码 mutation 同样在副作用前消费预算。浏览器若
              // 返回失败，本次高风险写入尝试仍然属于 Run 的资源使用。
              run = await this.store.updateRunProgress({
                ownerId: run.ownerId,
                runId: run.id,
                usage: {
                  ...run.usage,
                  fileMutations: run.usage.fileMutations + 1,
                },
              });
            }

            const suspended = await this.suspendForBrowserRepositoryTool({
              run,
              toolCall,
              argumentsJson,
              leaseId,
            });

            if (suspended) {
              return;
            }

            continue modelLoop;
          }

          if (isFileMutationTool(toolCall.name)) {
            if (run.usage.fileMutations >= run.budget.maxFileMutations) {
              throw new AgentError(
                AGENT_ERROR_CODES.fileMutationsExhausted,
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

          if (result.ok && isFileMutationTool(toolCall.name)) {
            const replayPlan = await this.store.findReplayableSmokePlan({
              ownerId: run.ownerId,
              runId: run.id,
              currentRevision: run.currentRevision,
            });

            if (replayPlan) {
              const replayArguments =
                browserVerifyToolArgumentsSchema.safeParse({
                  revision: run.currentRevision,
                  steps: replayPlan.smokeSteps,
                  acceptedNetworkFailures: replayPlan.acceptedNetworkFailures,
                });

              if (!replayArguments.success) {
                throw new AgentError(
                  AGENT_ERROR_CODES.toolInvalidArguments,
                  "持久化的 Browser smoke plan 已失效，无法自动重放。",
                  500,
                  { issues: replayArguments.error.issues },
                );
              }

              await this.suspendForBrowserVerify({
                run,
                toolCall: {
                  index: toolCall.index,
                  id: `replay:${toolCall.id}:${run.currentRevision}`,
                  name: BROWSER_VERIFY_TOOL_NAME,
                  argumentsText: JSON.stringify(replayArguments.data),
                },
                argumentsJson: replayArguments.data,
                leaseId,
                source: "replay",
                replayCount: replayPlan.replayCount + 1,
              });
              return;
            }
          }
        }

        run = await this.store.getRun({
          ownerId: run.ownerId,
          runId: run.id,
        });
      }

      // 只有显式配置的硬上限才能到达这里。budget_exhausted 是可恢复终态，
      // 后续“继续”会创建新 Run，并从持久化 Transcript/Checkpoint 重新组装
      // 上下文，不复用旧 AbortSignal 或旧 Run 的循环计数。
      if (run.budget.maxModelTurns !== null) {
        await this.finishRun(
          run,
          "budget_exhausted",
          AGENT_ERROR_CODES.modelTurnsExhausted,
          "Agent 已达到显式配置的最大模型轮次，可发送“继续”恢复执行。",
        );
      }
    } catch (error) {
      await this.handleTerminalError(input, error, leaseId);
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
    contextCheckpoint: Awaited<
      ReturnType<AgentStorePort["getContextCheckpoint"]>
    >;
    tools: readonly {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }[];
    attachmentContexts: ReadonlyMap<string, string>;
    leaseId: string;
    signal?: AbortSignal;
  }) {
    let assistantText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let usageObserved = false;
    let providerRequestStarted = false;
    let finishReason: ProviderFinishReason | null = null;
    const toolCalls = new Map<number, AccumulatedToolCall>();
    let heartbeatError: unknown = null;
    let heartbeatInFlight: Promise<void> | null = null;
    let interruption: AgentError | null = null;
    let budgetReservation: UsageBudgetReservation | null = null;
    const renewLease = () => {
      if (heartbeatError || heartbeatInFlight) {
        return;
      }

      heartbeatInFlight = this.store
        .renewExecutionLease({
          ownerId: input.run.ownerId,
          runId: input.run.id,
          leaseId: input.leaseId,
        })
        .catch((error: unknown) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    };
    const heartbeat = setInterval(
      renewLease,
      EXECUTION_LEASE_RENEW_INTERVAL_MS,
    );

    try {
      try {
        const messages = assembleProviderMessages(input.transcript, {
          systemPrompt: input.systemPrompt,
          maxMessageCharacters: input.run.budget.maxToolResultCharacters,
          // 单条工具结果最多 20,000 字符，但多轮读写会快速累积。
          // 这里保留最近上下文，避免“继续”请求超过模型上下文窗口。
          maxContextCharacters: 96_000,
          attachmentContexts: input.attachmentContexts,
          contextCheckpoint: input.contextCheckpoint,
          // Checkpoint 属于 Conversation，而模型循环属于当前 Run。并发 Run
          // 推进摘要后，当前 Run 已持久化的早期消息仍必须完整进入本轮上下文。
          protectedRunId: input.run.id,
        });
        const maxOutputTokens = Math.max(
          256,
          Math.ceil(input.run.budget.maxOutputCharacters / 4),
        );
        budgetReservation =
          (await this.reserveModelBudget?.({
            ownerId: input.run.ownerId,
            agentRunId: input.run.id,
            provider: input.run.provider,
            model: input.run.model,
            turn: input.run.usage.modelTurns + 1,
            estimatedInputTokens: estimateProviderInputTokens(messages),
            maxOutputTokens,
          })) ?? null;

        // Provider 的 streamTurn 本身就是请求入口。即使上游在首个事件前
        // 返回错误，请求也可能已经发出，因此这里采用保守的“已开始”语义。
        providerRequestStarted = true;
        for await (const event of this.provider.streamTurn({
          model: input.run.model,
          messages,
          tools: input.tools,
          maxOutputTokens,
          userId: input.run.ownerId,
          signal: input.signal,
        })) {
          if (heartbeatError) {
            throw heartbeatError;
          }

          switch (event.type) {
            case "text_delta":
              assistantText += event.text;
              if (assistantText.length > input.run.budget.maxOutputCharacters) {
                throw new AgentError(
                  AGENT_ERROR_CODES.outputExhausted,
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
              usageObserved = true;
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
      } catch (error) {
        // Provider 层只会在尚未产生任何事件时自行重试。若流已经输出了部分
        // 文本或 Tool Call 后中断，这一轮尚未执行任何工具副作用，可以由领域
        // 状态机丢弃临时输出并按冻结预算重试，避免用户等待到 120 秒总超时。
        if (
          isRetryablePartialProviderStream(error) &&
          (assistantText.length > 0 || toolCalls.size > 0)
        ) {
          interruption = error;
        } else {
          throw error;
        }
      }
    } finally {
      clearInterval(heartbeat);
      await heartbeatInFlight;
      if (this.settleModelBudget && budgetReservation) {
        await this.settleModelBudget({
          reservation: budgetReservation,
          provider: input.run.provider,
          inputTokens,
          outputTokens,
          providerRequestStarted,
          usageObserved,
        });
      }
    }

    if (heartbeatError) {
      // SSE 可能在一段静默推理后才返回下一条 chunk，因此租约续期必须独立于
      // chunk 到达。续租失败意味着当前实例已失去执行权，不能继续落库模型结果。
      throw heartbeatError;
    }

    return {
      assistantText,
      toolCalls: [...toolCalls.values()],
      inputTokens,
      outputTokens,
      usageObserved,
      providerRequestStarted,
      budgetReservation,
      finishReason,
      interruption,
    };
  }

  private hasRunAttachments(
    run: AgentRunRecord,
    transcript: readonly TranscriptMessage[],
  ): boolean {
    return transcript.some(
      (message) =>
        message.kind === "user_message" &&
        message.runId === run.id &&
        Boolean(message.attachmentIds?.length),
    );
  }

  private async persistToolResult(
    run: AgentRunRecord,
    toolCall: AccumulatedToolCall,
    result: AgentToolResultEnvelope,
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
        ...(result.ok ? {} : { errorCode: result.error?.code }),
      },
    });
  }

  /**
   * Provider 生成的客户端工具参数属于模型输出，不是用户请求或状态机事实。
   * 严格校验失败时写入成对的 tool_result，让模型能看到具体 issue 后自我修正；
   * 此时工具尚未执行，因此不创建 Tool Ledger，也不切换 awaiting 状态。
   *
   * revision 冲突、预算耗尽等错误发生在参数通过之后，仍由调用方抛出并终止，
   * 避免把真实并发冲突误包装成“请模型再猜一次”。
   */
  private async persistInvalidClientToolArguments(input: {
    run: AgentRunRecord;
    toolCall: AccumulatedToolCall;
    message: string;
    issues: readonly object[];
    persistLedger?: boolean;
  }): Promise<void> {
    const result = {
      ok: false,
      toolName: input.toolCall.name,
      revision: input.run.currentRevision,
      error: {
        code: AGENT_ERROR_CODES.toolInvalidArguments,
        message: input.message,
        details: {
          issues: toJsonRecords(input.issues),
        },
      },
    };

    if (input.persistLedger) {
      const ledger = await this.store.registerToolInvocation({
        runId: input.run.id,
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.name,
        executionDomain: "client",
        argumentsJson: asTranscriptArguments(
          parseToolArguments(input.toolCall.argumentsText),
          input.toolCall.argumentsText,
        ),
        idempotencyKey: `${input.run.id}:${input.toolCall.id}`,
        revisionBefore: input.run.currentRevision,
      });

      if (ledger.created) {
        await this.store.markToolInvocationRunning({
          runId: input.run.id,
          toolCallId: input.toolCall.id,
        });
        await this.store.completeToolInvocation({
          runId: input.run.id,
          toolCallId: input.toolCall.id,
          status: "failed",
          resultJson: result,
          revisionAfter: input.run.currentRevision,
          errorCode: AGENT_ERROR_CODES.toolInvalidArguments,
        });
      }
    }

    await this.store.appendTranscript({
      conversationId: input.run.conversationId,
      runId: input.run.id,
      role: "tool",
      kind: "tool_result",
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      resultJson: result,
    });
    await this.store.appendEvent({
      runId: input.run.id,
      type: "tool.completed",
      payload: {
        toolCallId: input.toolCall.id,
        toolName: input.toolCall.name,
        ok: false,
        revision: input.run.currentRevision,
        errorCode: AGENT_ERROR_CODES.toolInvalidArguments,
      },
    });
  }

  private async suspendForRunPreview(input: {
    run: AgentRunRecord;
    toolCall: AccumulatedToolCall;
    argumentsJson: unknown;
    leaseId: string;
  }): Promise<boolean> {
    const argumentsResult = runPreviewToolArgumentsSchema.safeParse(
      input.argumentsJson,
    );

    if (!argumentsResult.success) {
      await this.persistInvalidClientToolArguments({
        run: input.run,
        toolCall: input.toolCall,
        message: "工具 run_preview 的参数不合法。",
        issues: argumentsResult.error.issues,
      });
      return false;
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
        AGENT_ERROR_CODES.clientResumesExhausted,
        "Agent 已达到浏览器验证恢复次数上限。",
        409,
      );
    }

    const idempotencyKey = `${input.run.id}:${input.toolCall.id}`;
    await this.store.suspendForClientTool({
      ownerId: input.run.ownerId,
      runId: input.run.id,
      projectId: input.run.projectId,
      toolCallId: input.toolCall.id,
      toolName: RUN_PREVIEW_TOOL_NAME,
      argumentsJson: argumentsResult.data,
      idempotencyKey,
      revision: input.run.currentRevision,
      leaseId: input.leaseId,
    });
    return true;
  }

  private async suspendForBrowserVerify(input: {
    run: AgentRunRecord;
    toolCall: AccumulatedToolCall;
    argumentsJson: unknown;
    leaseId: string;
    source: "agent" | "replay";
    replayCount: number;
  }): Promise<boolean> {
    const argumentsResult = browserVerifyToolArgumentsSchema.safeParse(
      input.argumentsJson,
    );

    if (!argumentsResult.success) {
      // replay 参数来自已持久化且曾通过校验的 smoke plan。若它后来失效，
      // 说明服务端协议或数据发生漂移，不能伪装成一次可纠正的模型输出。
      if (input.source === "replay") {
        throw new AgentError(
          AGENT_ERROR_CODES.toolInvalidArguments,
          "持久化的 Browser smoke plan 已失效，无法自动重放。",
          500,
          { issues: argumentsResult.error.issues },
        );
      }

      await this.persistInvalidClientToolArguments({
        run: input.run,
        toolCall: input.toolCall,
        message: "工具 browser_verify 的参数不合法。",
        issues: argumentsResult.error.issues,
      });
      return false;
    }

    if (argumentsResult.data.revision !== input.run.currentRevision) {
      throw new AgentError(
        AGENT_ERROR_CODES.revisionConflict,
        "browser_verify 必须验证 Agent 当前持有的最新 revision。",
        409,
        {
          requestedRevision: argumentsResult.data.revision,
          currentRevision: input.run.currentRevision,
        },
      );
    }

    if (input.run.usage.clientResumes >= input.run.budget.maxClientResumes) {
      throw new AgentError(
        AGENT_ERROR_CODES.clientResumesExhausted,
        "Agent 已达到浏览器验证恢复次数上限。",
        409,
      );
    }

    const idempotencyKey = `${input.run.id}:${input.toolCall.id}`;
    await this.store.suspendForClientTool({
      ownerId: input.run.ownerId,
      runId: input.run.id,
      projectId: input.run.projectId,
      toolCallId: input.toolCall.id,
      toolName: BROWSER_VERIFY_TOOL_NAME,
      argumentsJson: argumentsResult.data,
      idempotencyKey,
      revision: input.run.currentRevision,
      leaseId: input.leaseId,
      source: input.source,
      replayCount: input.replayCount,
    });
    return true;
  }

  /**
   * Browser Git 的源码与 Git 历史只能由当前浏览器访问。服务端在这里验证模型
   * 参数和冻结权限，然后创建 client Tool Ledger；真正副作用由页面中的
   * BrowserGitProjectRepository 执行，服务端不会读取或重建本地仓库。
   */
  private async suspendForBrowserRepositoryTool(input: {
    run: AgentRunRecord;
    toolCall: AccumulatedToolCall;
    argumentsJson: unknown;
    leaseId: string;
  }): Promise<boolean> {
    const toolName = assertBrowserRepositoryToolName(input.toolCall.name);
    const schema = isGitTool(toolName)
      ? GIT_TOOL_SCHEMAS[toolName]
      : FILE_TOOL_SCHEMAS[toolName];
    const argumentsResult = schema.safeParse(input.argumentsJson);

    if (!argumentsResult.success) {
      await this.persistInvalidClientToolArguments({
        run: input.run,
        toolCall: input.toolCall,
        message: `工具 ${toolName} 的参数不合法。`,
        issues: argumentsResult.error.issues,
      });
      return false;
    }

    if (isFileMutationTool(toolName)) {
      const expectedRevision = getExpectedRevision(argumentsResult.data);
      if (expectedRevision !== input.run.currentRevision) {
        throw new AgentError(
          AGENT_ERROR_CODES.revisionConflict,
          "Browser Git 文件工具必须使用 Agent 当前持有的最新 revision。",
          409,
          {
            expectedRevision,
            currentRevision: input.run.currentRevision,
          },
        );
      }

      const pathToRead =
        toolName === FILE_TOOL_NAMES.renameFile
          ? argumentsResult.data.fromPath
          : toolName === FILE_TOOL_NAMES.writeFile ||
              toolName === FILE_TOOL_NAMES.deleteFile
            ? argumentsResult.data.path
            : null;
      const readBeforeMutation = pathToRead
        ? await this.store.findSuccessfulRead({
            runId: input.run.id,
            path: pathToRead!,
            revision: input.run.currentRevision,
          })
        : false;

      if (
        pathToRead &&
        !readBeforeMutation &&
        toolName !== FILE_TOOL_NAMES.writeFile
      ) {
        throw new AgentError(
          AGENT_ERROR_CODES.toolReadRequired,
          "修改已有文件前必须在同一 Run 和 revision 下调用 read_file。",
          409,
          { path: pathToRead, revision: input.run.currentRevision },
        );
      }
    }

    const intent = normalizeRepositoryIntent(
      input.run.repositoryCapability.repositoryIntent,
    );
    const permissionError =
      toolName === GIT_TOOL_NAMES.stage && !intent.allowStage
        ? "原始用户消息没有明确授权 stage，本次调用已拒绝。"
        : toolName === GIT_TOOL_NAMES.unstage && !intent.allowUnstage
          ? "原始用户消息没有明确授权 unstage，本次调用已拒绝。"
          : toolName === GIT_TOOL_NAMES.commit && !intent.allowCommit
            ? "原始用户消息没有明确授权 commit，本次调用已拒绝。"
            : toolName === GIT_TOOL_NAMES.commit && !intent.commitAuthor
              ? "commit 必须由用户明确提供作者姓名和邮箱，本次调用已拒绝。"
              : null;

    if (permissionError) {
      await this.persistInvalidClientToolArguments({
        run: input.run,
        toolCall: input.toolCall,
        message: permissionError,
        issues: [],
        persistLedger: true,
      });
      return false;
    }

    if (input.run.usage.clientResumes >= input.run.budget.maxClientResumes) {
      throw new AgentError(
        AGENT_ERROR_CODES.clientResumesExhausted,
        "Agent 已达到浏览器工具恢复次数上限。",
        409,
      );
    }

    await this.store.suspendForClientTool({
      ownerId: input.run.ownerId,
      runId: input.run.id,
      projectId: input.run.projectId,
      toolCallId: input.toolCall.id,
      toolName,
      argumentsJson: argumentsResult.data,
      idempotencyKey: `${input.run.id}:${input.toolCall.id}`,
      revision: input.run.currentRevision,
      leaseId: input.leaseId,
      ...(isFileMutationTool(toolName)
        ? {
            readBeforeMutation: await this.store.findSuccessfulRead({
              runId: input.run.id,
              path:
                toolName === FILE_TOOL_NAMES.renameFile
                  ? argumentsResult.data.fromPath
                  : argumentsResult.data.path,
              revision: input.run.currentRevision,
            }),
          }
        : {}),
      ...(toolName === GIT_TOOL_NAMES.commit
        ? { author: intent.commitAuthor! }
        : {}),
    });
    return true;
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

    if (status === "succeeded") {
      await this.completeSuccessfulRunWithRetry(latest);
    } else {
      await this.store.transitionRun({
        ownerId: latest.ownerId,
        runId: latest.id,
        status,
        errorCode: errorCode ?? null,
        errorMessage: errorMessage ?? null,
      });
    }
  }

  /**
   * Neon 的 WebSocket 连接可能在事务已经提交或即将开始时瞬时中断。
   * 第一次失败后必须先重读数据库事实：若 Run 已经 succeeded，说明提交成功但
   * 客户端没有收到确认；若仍为 running，完整事务可以安全重试一次。
   *
   * 成功 checkpoint 与 ChangeSet 都有 Run 级唯一约束，且第一次事务若未提交会
   * 整体回滚，因此这里只允许一次有界重试，不会制造重复历史记录。
   */
  private async completeSuccessfulRunWithRetry(
    run: AgentRunRecord,
  ): Promise<void> {
    try {
      await this.store.completeSuccessfulRun({
        ownerId: run.ownerId,
        runId: run.id,
      });
      return;
    } catch (firstError) {
      const persisted = await this.store.getRun({
        ownerId: run.ownerId,
        runId: run.id,
      });

      if (persisted.status === "succeeded") {
        return;
      }

      if (persisted.status !== "running") {
        throw firstError;
      }

      console.warn("[agent-orchestrator] retry successful finalization", {
        runId: persisted.id,
        correlationId: persisted.correlationId,
        error: firstError,
      });

      try {
        await this.store.completeSuccessfulRun({
          ownerId: persisted.ownerId,
          runId: persisted.id,
        });
      } catch (retryError) {
        console.error("[agent-orchestrator] successful finalization failed", {
          runId: persisted.id,
          correlationId: persisted.correlationId,
          error: retryError,
        });
        throw retryError;
      }
    }
  }

  private async handleTerminalError(
    input: { ownerId: string; runId: string },
    error: unknown,
    leaseId: string,
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

    if (run.executionLeaseId !== leaseId) {
      const healthyClientWait =
        run.status === "awaiting_client_tool" &&
        (await this.store.hasPendingClientToolWait(input));
      const ownedByNewExecutor =
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "awaiting_async_job";

      if (healthyClientWait || ownedByNewExecutor) {
        // 终止状态也是一种写操作，只能由仍持有租约的执行器提交。这里覆盖两种
        // 正常接管：浏览器已拿到客户端工具等待权，或另一个服务端实例已接管。
        // 旧实例无论收到何种迟到错误，都不能覆盖更新后的数据库事实。
        return;
      }
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
      if (
        error.code === AGENT_ERROR_CODES.runConflict &&
        run.status === "awaiting_client_tool" &&
        (await this.store.hasPendingClientToolWait(input))
      ) {
        // 当前实例已失去租约，但另一个执行器已经建立可恢复的客户端等待事实。
        // 旧实例必须静默退出，不能用自己的迟到冲突覆盖健康的 awaiting 状态。
        return;
      }

      if (error.code === AGENT_ERROR_CODES.cancelled) {
        await this.finishRun(run, "cancelled", error.code, error.message);
        return;
      }

      if (isAgentBudgetErrorCode(error.code)) {
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

    console.error(
      "[agent-orchestrator] terminal error",
      JSON.stringify({
        runId: run.id,
        correlationId: run.correlationId,
        ...serializeAgentError(error),
      }),
    );
    await this.finishRun(
      run,
      "failed",
      "AGENT_INTERNAL_ERROR",
      "Agent 执行过程中发生未知错误。",
    );
  }
}

function parseImageToolArguments(value: unknown):
  | {
      ok: true;
      data: Record<string, unknown>;
    }
  | {
      ok: false;
      issues: readonly object[];
    } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, data: value as Record<string, unknown> };
  }

  return {
    ok: false,
    issues: [{ path: [], message: "参数必须是 JSON 对象。" }],
  };
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

function toJsonRecords(
  values: readonly object[],
): Array<Record<string, unknown>> {
  return values.map((value) => ({ ...value }));
}

function enforceOneMutationPerTurn(
  toolCalls: readonly AccumulatedToolCall[],
): void {
  const mutationNames = new Set<string>([
    FILE_TOOL_NAMES.writeFile,
    FILE_TOOL_NAMES.deleteFile,
    FILE_TOOL_NAMES.renameFile,
    GIT_TOOL_NAMES.stage,
    GIT_TOOL_NAMES.unstage,
    GIT_TOOL_NAMES.commit,
  ]);
  const mutationCount = toolCalls.filter((toolCall) =>
    mutationNames.has(toolCall.name),
  ).length;

  if (mutationCount > 1) {
    throw new AgentError(
      AGENT_ERROR_CODES.toolInvalidArguments,
      "同一模型轮次最多只能执行一个 Repository mutation。",
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

function isGitTool(toolName: string): toolName is GitToolName {
  return Object.values(GIT_TOOL_NAMES).includes(toolName as GitToolName);
}

function isBrowserRepositoryTool(
  toolName: string,
): toolName is FileToolName | GitToolName {
  return (
    Object.values(FILE_TOOL_NAMES).includes(toolName as FileToolName) ||
    isGitTool(toolName)
  );
}

function assertBrowserRepositoryToolName(
  toolName: string,
): FileToolName | GitToolName {
  if (isBrowserRepositoryTool(toolName)) {
    return toolName;
  }

  throw new AgentError(
    AGENT_ERROR_CODES.toolInvalidArguments,
    `未知 Browser Repository 工具：${toolName}。`,
    400,
  );
}

function getExpectedRevision(argumentsJson: Record<string, unknown>): number {
  const revision = argumentsJson.expectedRevision;
  return typeof revision === "number" && Number.isInteger(revision)
    ? revision
    : -1;
}

function assertWithinWallTime(run: AgentRunRecord): void {
  if (
    getActiveExecutionDurationMs(run.usage, new Date()) >
    run.budget.maxWallTimeSeconds * 1000
  ) {
    throw new AgentError(
      AGENT_ERROR_CODES.wallTimeExhausted,
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

/**
 * 仅允许重试“宣称要调用工具但整轮没有工具数据”的供应商缺帧。
 * 一旦存在 Tool Call，就交给严格校验检查 id/name/finish reason，
 * 防止把半截参数或协议错乱误判成一次无害重试。
 */
function isRetryableEmptyToolCallTurn(turn: {
  finishReason: ProviderFinishReason | null;
  toolCalls: readonly AccumulatedToolCall[];
}): boolean {
  return turn.finishReason === "tool_calls" && turn.toolCalls.length === 0;
}

function isRetryablePartialProviderStream(error: unknown): error is AgentError {
  return (
    isAgentError(error) &&
    (error.code === AGENT_ERROR_CODES.providerTimeout ||
      error.code === AGENT_ERROR_CODES.providerInterrupted)
  );
}
