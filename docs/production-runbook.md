# WebPilot Studio 生产上线 Runbook

本文用于主站和 Showcase Runtime 的发布前验收、故障定位和回滚。命令默认在
`webpilot-studio/` 目录执行，所有生产命令都应该使用与 Vercel 一致的 Node.js
22.x 和 pnpm 11.9.0。

## 1. 部署角色确认

项目由两个 Vercel Project 组成：

| 部署             | 必须返回                                        | 用途                                     |
| ---------------- | ----------------------------------------------- | ---------------------------------------- |
| 主站             | `/health` 返回 `deployment: "primary"`          | 工作台、Agent API、项目和发布管理        |
| Showcase Runtime | `/health` 返回 `deployment: "showcase-runtime"` | 只读取已发布 artifact 并提供 iframe 页面 |

发布前分别执行：

```bash
curl -fsS https://studio.example.com/health
curl -fsS https://showcase.example.com/health
```

不要只检查 HTTP 200。还要确认：

- 主站的根路径和 `/p/<projectId>` 可以打开；
- Runtime 的根路径可以是部署说明页，但 `/api/projects`、`/api/agent-runs`
  等主站路径必须返回 404；
- Runtime 的 `/showcase/runtime/<artifactId>/` 可以返回发布产物；
- 主站配置的 `SHOWCASE_ORIGIN` 与 Runtime 的实际生产域名完全一致，不带尾部 `/`。

## 2. Vercel 环境变量

### 主站 Production

必须配置：

```text
NEXT_PUBLIC_SITE_URL
DATABASE_URL
BLOB_READ_WRITE_TOKEN
ANON_SESSION_SECRET
LLM_PROVIDER
LLM_BASE_URL
LLM_API_KEY
LLM_AGENT_MODEL
```

启用图片理解、图片生成或附件时，再配置对应的：

```text
VISION_PROVIDER
VISION_BASE_URL
VISION_API_KEY
VISION_MODEL
VISION_TIMEOUT_MS
IMAGE_PROVIDER
IMAGE_BASE_URL
IMAGE_API_KEY
IMAGE_MODEL
```

生产限流默认要求 Redis：

```text
REDIS_URL
REDIS_TOKEN
RATE_LIMIT_REDIS_REQUIRED=true
```

如果使用 Vercel Queue，队列由 Vercel Project 的 Queue/OIDC 能力提供；本地或
自托管保底路径才使用：

```text
QUEUE_URL
QUEUE_TOKEN
```

Showcase 管理和跨域页面还需要：

```text
SHOWCASE_ADMIN_TOKEN
SHOWCASE_ORIGIN
SHOWCASE_PARENT_ORIGIN
SHOWCASE_RUNTIME_ONLY=false
```

推荐上线时显式设置功能开关和资源限制，不依赖代码默认值：

```text
AGENT_ENABLED=true
IMAGE_GENERATION_ENABLED=true
ATTACHMENT_UPLOAD_ENABLED=true
ANON_RUNS_PER_IP_PER_DAY
ANON_RUNS_PER_OWNER_PER_DAY
MAX_CONCURRENT_RUNS_PER_OWNER
MAX_GLOBAL_AGENT_RUNS
ANON_IMAGE_RUNS_PER_IP_PER_DAY
ANON_IMAGE_RUNS_PER_OWNER_PER_DAY
MAX_CONCURRENT_IMAGE_RUNS_PER_OWNER
MAX_GLOBAL_IMAGE_RUNS
ANON_ATTACHMENTS_PER_IP_PER_DAY
ANON_ATTACHMENTS_PER_OWNER_PER_DAY
MAX_CONCURRENT_UPLOADS_PER_OWNER
MAX_AGENT_MODEL_TURNS
MAX_AGENT_FILE_MUTATIONS
MAX_AGENT_WALL_TIME_SECONDS
```

只有在已经确认价格表和预算告警策略后，才配置全局成本熔断：

```text
MAX_GLOBAL_DAILY_COST_USD
LLM_INPUT_COST_PER_1M_USD
LLM_OUTPUT_COST_PER_1M_USD
VISION_INPUT_COST_PER_1M_USD
VISION_OUTPUT_COST_PER_1M_USD
IMAGE_COST_PER_GENERATION_USD
```

所有 Provider、数据库、Blob、Queue、Redis 和管理 Token 都必须是服务端变量，
不能使用 `NEXT_PUBLIC_` 前缀。Showcase Runtime 不配置 Agent、图片模型、Queue、
Redis、匿名会话和管理 Token。

## 3. 跨源隔离与 WebContainer

主站所有文档响应必须同时包含：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

浏览器验收：

```bash
curl -fsSI https://studio.example.com/p/<projectId>
```

然后在浏览器控制台确认：

```js
window.crossOriginIsolated === true;
```

WebContainer 的正确生命周期是：

1. 首次进入工作台只恢复项目文件和界面，不自动授权启动运行镜像。
2. 用户显式打开 Preview 或 Agent 请求 `run_preview` 后执行 `boot`。
3. 按 `mount -> install -> dev server -> server-ready` 串行推进。
4. 依赖或构建配置变化时重建运行镜像；普通源码变化走增量同步。
5. React 组件卸载不会自动 `teardown`，同一标签页内复用容器；切换项目时才释放旧容器。
6. Preview iframe 只在 dev server 已 ready 且 URL 属于当前项目时显示。

发布前至少执行一次：

```bash
pnpm test:e2e
PLAYWRIGHT_BASE_URL=https://studio.example.com pnpm test:e2e:preview
```

远程 Preview smoke 还要确认 iframe 能加载、Preview URL 使用预期端口、页面没有
因为 COOP/COEP 缺失而停在 `cross_origin_isolation_required`。

## 4. Agent 验收

使用一个新项目执行最小闭环：

1. 新建项目后确认初始文件来自项目模板，不能把主站源码或旧项目文件挂入运行镜像。
2. 发送一个只读问题，确认 Agent Run 能进入 `queued/running` 并持续返回 SSE 事件。
3. 发送一个小型代码修改，确认文件 mutation、revision、ChangeSet 和 Preview 事实均落库。
4. 让 Agent 执行 Preview，再执行一次浏览器验证，确认结果绑定到同一 revision。
5. 刷新工作台，确认历史消息、Run 状态和可恢复 Preview 不会丢失。
6. 取消运行，确认服务端状态变成 `cancelled`，并发 lease 最终释放。
7. 让模型连续修改多个文件，确认预算耗尽时返回明确的预算错误，而不是通用的 Provider 错误。

重点检查：

- Run 创建时冻结 Provider、模型和预算，恢复执行不能悄悄切换模型；
- `MAX_AGENT_MODEL_TURNS`、`MAX_AGENT_FILE_MUTATIONS` 和
  `MAX_AGENT_WALL_TIME_SECONDS` 是单个 Run 的硬边界；
- `no-progress` 熔断和全局并发限制仍然生效；
- SSE 断线重连不会重复提交客户端工具结果；
- 每个错误都能通过响应头或 Run 记录中的 `correlationId` 追踪。

## 5. 图片、视觉和异步 Queue

### 图片理解和生成

先用小文件和低数量请求测试：

```text
图片上传 -> attachment 读取 -> inspect_attachment
文本请求 -> generate_image -> Queue -> Blob -> project asset
```

确认失败时：

- Provider 未配置返回稳定的配置错误；
- 无效 MIME、超大图片和模型返回异常数量会被拒绝；
- Provider 请求开始后即使超时，也不会把可能已产生的费用错误释放；
- 生成失败会清理本次新建且无引用的 Blob；
- 父 Agent 不会永久停在 `awaiting_async_job`。

### Queue

检查 Vercel Queue topic `webpilot-image-generation` 和消费者函数的
`visibilityTimeoutSeconds`、`maxDuration` 是否一致。使用一条测试生图任务确认：

- `send` 使用 image job idempotency key；
- 重复投递只会有一个数据库 job lease；
- retryable 错误会重新入队；
- 达到最大重试次数后 Image Run 和父 Agent Run 都进入终态；
- Queue callback 不需要浏览器 CSRF Cookie，但必须经过平台签名校验。

## 6. Redis、PostgreSQL 和 Blob 故障

### Redis

Redis 是高频准入层，PostgreSQL 是额度和租约事实层。生产要求：

```bash
vercel env ls
vercel env run -- pnpm test:infrastructure
```

故障时按以下顺序判断：

1. `RATE_LIMIT_REDIS_REQUIRED=true` 且 Redis 不可用：新任务应返回 503，不得绕过限流。
2. 非强制模式下 Redis 暂时不可用：代码会回退 PostgreSQL，但必须监控日志中的
   `[quota] redis unavailable`，恢复后再切回 Redis。
3. 释放操作失败：数据库终态不回滚；Redis lease 依靠 TTL 过期，并通过
   `[quota] redis reservation release failed` 进入补偿排查。
4. 跨 UTC 零点的 reservation 必须按创建时 `bucketDate` 释放，不能按当前日期退款。

### PostgreSQL

只读健康检查：

```bash
vercel env run -- pnpm test:infrastructure
```

迁移前：

1. 在 Neon 创建可恢复的数据库分支或快照。
2. 确认当前生产部署和待执行 migration 的 git SHA。
3. 先在 Preview/分支数据库执行完整 migration 和数据库测试。

执行迁移：

```bash
vercel env pull .env.production.local
pnpm db:migrate
```

迁移脚本只负责显式执行 migration，不应放入 Next.js 启动过程。回滚优先使用
应用版本回滚；数据库 migration 没有自动 down migration 时，应准备经审核的
反向 SQL 或恢复 Neon 分支，禁止临时手改生产表结构。

### Vercel Blob

Blob 必须使用 private access。上传、读取和删除都通过应用服务端适配层完成，
浏览器只能拿到经过权限检查的应用路径。发现孤儿对象时，先根据数据库引用检查
`project_file_blobs`、`chat_attachments`、`project_assets` 和 Showcase artifact
记录，再执行清理，不要按前缀直接删除。

## 7. 日志、关联 ID 和告警

API 响应会返回 `x-correlation-id`。收到用户报错时先记录：

```text
生产域名
发生时间，使用 UTC
projectId / runId / imageRunId
浏览器请求的 x-correlation-id
错误码和 HTTP 状态
```

在 Vercel Functions 日志中按 correlation ID 和实体 ID 查询，同时查看：

- `[agent-api]`、`[agent-runtime]`、`[agent-orchestrator]`
- `[quota]`
- `[image-api]`、`[image-worker]`、`[image-generation-queue]`
- `[showcase-api]`、`[showcase-runtime]`

上线后至少配置以下告警：

- `/health` 非 2xx 或部署角色错误；
- Agent/图片 5xx、Provider timeout、Queue retry 增长；
- Redis fallback、reservation rollback/release failed；
- PostgreSQL 连接失败、迁移失败；
- Blob 上传失败、读取 404 增长；
- `budget_exhausted`、全局预算接近上限；
- WebContainer smoke 中 `crossOriginIsolated` 变为 false；
- 新 Run 长时间停留在 `queued`、`running` 或 `awaiting_async_job`。

## 8. 全局预算熔断演练

只在 Preview 或专用生产演练窗口执行：

1. 设置一个很小但非零的 `MAX_GLOBAL_DAILY_COST_USD`。
2. 同时配置所有启用 Provider 的输入、输出、视觉和生图价格。
3. 发起一轮 Agent 请求，确认预算以 `reserved -> settled` 写入账本。
4. 并发发起第二轮请求，确认数据库行锁只允许不超过预算的请求通过。
5. 确认超限请求返回 `GLOBAL_BUDGET_EXHAUSTED` 和 HTTP 429。
6. 取消一个尚未发出 Provider 请求的 Run，确认 reservation 变成 released，
   预算桶得到退回。
7. 将预算恢复到正式值，再重新执行一次最小 Agent smoke。

演练结束后必须检查账本没有残留的测试 `agentRunId`、`imageRunId` 和孤儿 Blob。

## 9. 发布与回滚

### 发布前门禁

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm exec vitest run --config vitest.database.config.ts
pnpm test
pnpm build
pnpm exec playwright test
git diff --check
```

然后执行远程验收：

```bash
PLAYWRIGHT_BASE_URL=https://studio.example.com pnpm test:e2e:preview
vercel env run -- pnpm test:infrastructure
```

### Vercel 回滚

1. 立刻停止继续推广当前 Preview/Production。
2. 保存失败部署的 URL、git SHA、correlation ID、Vercel Function 日志和数据库迁移状态。
3. 在 Vercel 控制台选择上一个已通过 Preview smoke 的 Production deployment，
   执行 Promote/Rollback。
4. 主站和 Showcase Runtime 必须分别回滚到兼容的版本，不能只回滚其中一个。
5. 回滚后重新检查两个 `/health`、主站 Header、Showcase artifact、Agent 最小闭环
   和图片 Queue。
6. 如果故障来自数据库 migration，先停止会写入新结构的应用版本，再按 Neon 快照或
   已审核反向 SQL 恢复；应用回滚不能代替数据库回滚。
7. 记录事故时间线、影响范围、根因和补充测试，再恢复正常发布流程。
