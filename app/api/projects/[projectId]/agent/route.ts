import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  agentApiErrorResponse,
  agentJsonResponse,
  createRequestCorrelationId,
  getAgentPersistence,
  readAgentJsonBody,
} from "@/infrastructure/http/agent-api";

const paramsSchema = z.object({ projectId: z.uuid() }).strict();
const createConversationSchema = z
  .object({ title: z.string().trim().min(1).max(160) })
  .strict();

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = paramsSchema.parse(await context.params);
    const conversationId = z
      .uuid()
      .optional()
      .parse(
        new URL(request.url).searchParams.get("conversationId") ?? undefined,
      );
    const { store, repository } = getAgentPersistence();

    // 先通过 Repository 做 owner/project 隔离，再查询会话列表。
    await repository.describe({ ownerId, projectId });
    const conversations = await store.listConversations({ ownerId, projectId });
    const selectedConversationId =
      conversationId ?? conversations[0]?.id ?? null;
    const snapshot = selectedConversationId
      ? await store.getConversationSnapshot({
          ownerId,
          conversationId: selectedConversationId,
        })
      : null;

    return agentJsonResponse({ conversations, snapshot }, correlationId);
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { projectId } = paramsSchema.parse(await context.params);
    const body = createConversationSchema.parse(
      await readAgentJsonBody(request),
    );
    const { store } = getAgentPersistence();
    const conversation = await store.createConversation({
      ownerId,
      projectId,
      title: body.title,
    });

    return agentJsonResponse({ conversation }, correlationId, { status: 201 });
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}
