import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const crossOriginIsolationHeaders = [
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  {
    key: "Cross-Origin-Embedder-Policy",
    value: "require-corp",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // WebContainer 依赖 SharedArrayBuffer，COOP 与 COEP 必须在首次文档响应时同时存在。
        // 首页到工作台使用客户端导航，因此全站保持同一隔离策略，避免从非隔离页面进入
        // 工作台后只能依靠用户手动完整刷新才能启动运行时。
        source: "/:path*",
        headers: crossOriginIsolationHeaders,
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
