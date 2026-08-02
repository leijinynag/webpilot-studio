import "server-only";

import { send } from "@vercel/queue";

import type {
  ImageJobMessage,
  JobQueue,
} from "@/infrastructure/queue/job-queue";

export const IMAGE_QUEUE_TOPIC = "webpilot-image-generation";

export class VercelImageJobQueue implements JobQueue {
  async enqueue(message: ImageJobMessage): Promise<void> {
    await send(IMAGE_QUEUE_TOPIC, message, {
      idempotencyKey: message.imageJobId,
      retentionSeconds: 86_400,
    });
  }
}
