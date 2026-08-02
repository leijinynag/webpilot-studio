import "server-only";

import type {
  ImageJobMessage,
  JobQueue,
} from "@/infrastructure/queue/job-queue";
import { processNextImageJob } from "@/domains/image/worker";

/**
 * 本地和 Vercel Queue 尚未配置时的保底实现。
 *
 * 它不改变数据库状态机，只在当前函数中触发一次 Worker；Worker 仍然必须
 * 通过 lease 抢占 image_jobs，因此重复触发不会重复生成资产。
 */
export class PostgresImageJobQueue implements JobQueue {
  async enqueue(message: ImageJobMessage): Promise<void> {
    // 本地保底队列不阻塞 Agent 的恢复入口。数据库 lease 仍负责幂等，
    // 进程退出时任务会保持 queued，下一次恢复请求可以再次投递。
    void processNextImageJob({ expectedJobId: message.imageJobId }).catch(
      (error) => {
        console.error("[postgres-image-queue]", error);
      },
    );
  }
}
