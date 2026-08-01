# Showcase Runtime Vercel 部署

Showcase Runtime 使用同一份仓库代码部署为第二个 Vercel Project，例如
`webpilot-showcase`。它只对外提供 `/showcase/runtime/:artifactId/*`，
主站通过 `SHOWCASE_ORIGIN` 把详情页 iframe 指向该独立域名。

## Runtime 环境变量

只配置以下变量：

```text
DATABASE_URL=<Neon 只读连接串>
BLOB_READ_WRITE_TOKEN=<Vercel Blob token>
SHOWCASE_ORIGIN=https://showcase.example.com
SHOWCASE_PARENT_ORIGIN=https://webpilot.example.com
```

不要配置：

- `ANON_SESSION_SECRET`
- `LLM_API_KEY`
- `VISION_API_KEY`
- `IMAGE_API_KEY`
- `QUEUE_URL` / `QUEUE_TOKEN`
- `REDIS_URL` / `REDIS_TOKEN`
- `SHOWCASE_ADMIN_TOKEN`

`DATABASE_URL` 应使用只允许读取 `showcase_cases` 和
`showcase_artifacts` 的 PostgreSQL 角色。Vercel Blob SDK 的私有读取仍使用
`BLOB_READ_WRITE_TOKEN` 这个平台变量名，但 Runtime 代码只调用 `get()`。

## 主站配置

主站配置同一个 `SHOWCASE_ORIGIN`。配置后，主站域名直接访问 Runtime 路由会
返回 404，避免形成第二条未隔离入口。

Runtime 路由不会签发匿名 owner Cookie。使用独立域名后，浏览器也不会把主站
host-only Cookie 发送到 Runtime。
