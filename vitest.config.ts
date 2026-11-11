import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@dockside/core": src("./packages/core/src/index.ts"),
      "@dockside/store": src("./packages/store/src/index.ts"),
      "@dockside/authority": src("./packages/authority/src/index.ts"),
      "@dockside/near": src("./packages/near/src/index.ts"),
      "@dockside/api": src("./services/api/src/app.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "services/*/test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 60000,
  },
});
