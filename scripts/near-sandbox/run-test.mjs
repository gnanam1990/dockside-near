// Opt-in suite against a local nearcore sandbox in a Linux container (Docker inside WSL 2).
// Usage: pnpm run build && pnpm run test:sandbox
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["vitest", "run", "services/api/test/m17-near-sandbox.test.ts"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DOCKSIDE_NEAR_SANDBOX: "1" },
});
process.exit(r.status ?? 1);
