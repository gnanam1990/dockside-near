// Opt-in suites against a local nearcore sandbox in a Linux container (Docker inside WSL 2):
// M17 NEAR account ownership and the M43 relayer function-call key signer (needs .data/repro from
// `pnpm run contract:reproduce`). The M43 browser product path is `pnpm run web:e2e:sandbox`.
// Usage: pnpm run build && pnpm run test:sandbox
import { spawnSync } from "node:child_process";

const r = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "services/api/test/m17-near-sandbox.test.ts",
    "services/worker/test/m43-relayer-sandbox.test.ts",
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DOCKSIDE_NEAR_SANDBOX: "1" },
  },
);
process.exit(r.status ?? 1);
