import "server-only";

import type { JobQueue } from "@/infrastructure/queue/job-queue";
import { PostgresImageJobQueue } from "@/infrastructure/queue/postgres-image-queue";
import { VercelImageJobQueue } from "@/infrastructure/queue/vercel-image-queue";
import { serverEnv } from "@/infrastructure/env/server";

export function getImageJobQueue(): JobQueue {
  // Vercel Queue 在 Vercel 运行时通过 OIDC 自动获取凭据，不要求把
  // Queue Token 暴露成业务环境变量；本地或自托管环境仍保留 Postgres 保底实现。
  if (
    process.env.VERCEL === "1" ||
    (serverEnv.QUEUE_URL && serverEnv.QUEUE_TOKEN)
  ) {
    return new VercelImageJobQueue();
  }
  return new PostgresImageJobQueue();
}
