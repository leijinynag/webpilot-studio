# Showcase Runtime Vercel 部署

Showcase Runtime 使用同一份仓库代码部署为第二个 Vercel Project：
`webpilot-showcase`，生产域名为
`https://webpilot-showcase.vercel.app`。它只对外提供
`/showcase/runtime/:artifactId/*`，
主站通过 `SHOWCASE_ORIGIN` 把详情页 iframe 指向该独立域名。

## Runtime 环境变量

只配置以下变量：

```text
DATABASE_URL=<Neon 只读连接串>
BLOB_READ_WRITE_TOKEN=<Vercel Blob token>
SHOWCASE_ORIGIN=https://showcase.example.com
SHOWCASE_PARENT_ORIGIN=https://webpilot.example.com
SHOWCASE_RUNTIME_ONLY=true
```

不要配置：

- `ANON_SESSION_SECRET`
- `LLM_API_KEY`
- `VISION_API_KEY`
- `IMAGE_API_KEY`
- `QUEUE_URL` / `QUEUE_TOKEN`
- `REDIS_URL` / `REDIS_TOKEN`
- `SHOWCASE_ADMIN_TOKEN`

`SHOWCASE_RUNTIME_ONLY=true` 是第二个 Vercel Project 的强制边界。它会让
`/showcase/runtime/:artifactId/*` 和 `/_next/*` 之外的请求返回 404，因此不会
把主站页面、Agent API 或管理员发布接口一起部署成第二个公开入口。

`DATABASE_URL` 应使用只允许读取 `showcase_cases` 和
`showcase_artifacts` 的 PostgreSQL 角色。Vercel Blob SDK 的私有读取仍使用
`BLOB_READ_WRITE_TOKEN` 这个平台变量名，但 Runtime 代码只调用 `get()`。

## 主站配置

主站配置同一个 `SHOWCASE_ORIGIN`。配置后，主站域名直接访问 Runtime 路由会
返回 404，避免形成第二条未隔离入口。

Runtime 路由不会签发匿名 owner Cookie。使用独立域名后，浏览器也不会把主站
host-only Cookie 发送到 Runtime。

## 创建第二个 Vercel Project

两个 Project 使用同一份 Git 仓库和构建命令，但环境变量不同：

1. 在 Vercel 新建 `webpilot-showcase`，连接同一个 Git 仓库。
2. 为该 Project 配置上面的四个 Runtime 变量，并设置 `SHOWCASE_RUNTIME_ONLY=true`。
3. 主站 Project 配置 `SHOWCASE_ORIGIN` 和 `SHOWCASE_PARENT_ORIGIN`，但不要配置
   `SHOWCASE_RUNTIME_ONLY=true`。
4. 将 `SHOWCASE_ORIGIN` 指向第二个 Project 的独立域名，再分别部署 Preview 和
   Production。

当前 Production 部署已完成，别名为
`https://webpilot-showcase.vercel.app`。部署检查地址和项目配置保留在
Vercel Project 中，文档不记录任何数据库、Blob 或管理密钥。

Runtime Project 的数据库角色只授予 Showcase 两张表的读取权限，Blob token
只用于 `get()`；主站的 LLM、队列、Redis、匿名会话和管理员 token 不复制过去。
