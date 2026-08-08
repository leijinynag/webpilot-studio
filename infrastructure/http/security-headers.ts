/**
 * 主站页面的安全响应头。
 *
 * WebPilot 的工作台同时包含 Monaco、WebContainer 和跨源 Preview：
 * - Monaco Worker 需要 blob: worker；
 * - WebContainer Preview 需要允许跨源 iframe；
 * - Agent SSE 和后续浏览器工具可能连接到 HTTPS/WSS 服务；
 * - 用户项目中的图片可能来自 data:、blob: 或受控的 HTTPS 资源。
 *
 * 因此这里采用“收紧默认能力、明确保留运行时协议”的 CSP，而不是
 * 把主站误配置成仅允许 same-origin 的静态页面策略。
 */
export function getMainApplicationSecurityHeaders(
  isDevelopment = process.env.NODE_ENV !== "production",
): Array<{ key: string; value: string }> {
  const scriptSources = [
    "'self'",
    // Next.js 的 Server Component hydration 需要 inline bootstrap。
    "'unsafe-inline'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        `script-src ${scriptSources}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: https:",
        // WebContainer 的端口代理、Agent SSE 和未来的浏览器调试通道
        // 都可能使用 HTTPS 或 WSS；HTTP 页面本身仍只允许同源连接。
        "connect-src 'self' https: wss:",
        "worker-src 'self' blob:",
        "child-src 'self' blob:",
        "frame-src 'self' https: blob:",
        "media-src 'self' data: blob: https:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        "manifest-src 'self'",
      ].join("; "),
    },
    {
      key: "Permissions-Policy",
      value: [
        "camera=()",
        "geolocation=()",
        "microphone=()",
        "payment=()",
        "usb=()",
      ].join(", "),
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
  ];
}
