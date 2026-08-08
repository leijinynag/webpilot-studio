import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { getMainApplicationSecurityHeaders } from "./infrastructure/http/security-headers";

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
  // Next.js 16 的开发工具按钮会覆盖工作台左下角，产品界面不需要它。
  devIndicators: false,
  async headers() {
    return [
      {
        // WebContainer 依赖 SharedArrayBuffer，COOP 与 COEP 必须在首次文档响应时同时存在。
        // 首页到工作台使用客户端导航，因此全站保持同一隔离策略，避免从非隔离页面进入
        // 工作台后只能依靠用户手动完整刷新才能启动运行时。
        source: "/:path*",
        headers: [
          ...crossOriginIsolationHeaders,
          ...getMainApplicationSecurityHeaders(),
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
