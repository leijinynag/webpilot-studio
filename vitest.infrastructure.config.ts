import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

// Live 验收与常规 test 分离：普通提交不依赖云端密钥，显式执行该配置时则要求
// Neon 和 Blob 都真实可用，任一变量缺失或远端调用失败都会让命令退出非零。
export default defineConfig({
  resolve: {
    alias: {
      "@": rootDirectory,
    },
  },
  test: {
    environment: "node",
    include: ["tests/infrastructure/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
