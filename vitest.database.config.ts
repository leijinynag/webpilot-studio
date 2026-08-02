import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

// 数据库 smoke 使用独立 Node 环境。测试默认运行内存中的 PGlite，
// 因而既能覆盖真实 PostgreSQL DDL/事务，又不会读取或污染远端 Neon。
export default defineConfig({
  resolve: {
    alias: {
      "@": rootDirectory,
      "server-only": path.join(
        rootDirectory,
        "tests/database/server-only-shim.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/database/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
