import { z } from "zod";

import { requireRequestOwner } from "@/domains/auth/request-owner";
import {
  agentApiErrorResponse,
  createRequestCorrelationId,
  getAgentPersistence,
} from "@/infrastructure/http/agent-api";
import {
  formatAgentHeartbeatSse,
  formatAgentRunEventSse,
} from "@/infrastructure/http/agent-sse";

const paramsSchema = z.object({ runId: z.uuid() }).strict();
const cursorSchema = z.coerce.number().int().nonnegative();
const encoder = new TextEncoder();

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const correlationId = createRequestCorrelationId(request);

  try {
    const ownerId = await requireRequestOwner();
    const { runId } = paramsSchema.parse(await context.params);
    const url = new URL(request.url);
    const rawCursor =
      url.searchParams.get("cursor") ??
      request.headers.get("last-event-id") ??
      "0";
    let cursor = cursorSchema.parse(rawCursor);
    const { store } = getAgentPersistence();
    await store.getRun({ ownerId, runId });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastHeartbeat = Date.now();

        try {
          while (!request.signal.aborted) {
            const events = await store.listEventsAfter({
              ownerId,
              runId,
              cursor,
            });

            for (const event of events) {
              cursor = event.sequence;
              controller.enqueue(encoder.encode(formatAgentRunEventSse(event)));
            }

            const run = await store.getRun({ ownerId, runId });
            const terminal =
              run.status === "succeeded" ||
              run.status === "failed" ||
              run.status === "cancelled" ||
              run.status === "budget_exhausted" ||
              run.status === "conflicted";

            if (terminal && events.length === 0) {
              controller.close();
              return;
            }

            if (Date.now() - lastHeartbeat >= 10_000) {
              controller.enqueue(encoder.encode(formatAgentHeartbeatSse()));
              lastHeartbeat = Date.now();
            }

            await delay(750, request.signal);
          }
        } catch (error) {
          if (!request.signal.aborted) {
            controller.error(error);
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "x-correlation-id": correlationId,
      },
    });
  } catch (error) {
    return agentApiErrorResponse(error, correlationId);
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
