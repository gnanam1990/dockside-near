import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { RECOVERY_DELAY_MS } from "./e2e/stack";
import base from "./playwright.config";

/**
 * The unexpected-asset recovery browser test (M11) runs against its OWN local stack on separate
 * ports. Its contract enforces a 72-hour challenge window, which the test passes by moving the
 * SIMULATED chain clock forward (`/control/chain-time`). The API keeps the wall clock, so on a
 * shared stack every later signed payload would read as expired on the chain; a dedicated stack
 * keeps the main suite's chain clock untouched. Everything else is the same as playwright.config.
 */
const API_PORT = Number(process.env["DOCKSIDE_E2E_ASSETS_API_PORT"] ?? 8795);
const CONTROL_PORT = Number(process.env["DOCKSIDE_E2E_ASSETS_CONTROL_PORT"] ?? 8796);
const WEB_PORT = Number(process.env["DOCKSIDE_E2E_ASSETS_WEB_PORT"] ?? 4393);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
// e2e/stack.ts reads the control port from this variable in the runner and in workers.
process.env["DOCKSIDE_E2E_CONTROL_PORT"] = String(CONTROL_PORT);
const dataDir = mkdtempSync(join(tmpdir(), "dockside-e2e-assets-"));

export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: ["asset-recovery.spec.ts"],
  testIgnore: [],
  use: { ...base.use, baseURL: WEB },
  webServer: [
    {
      command:
        "node --experimental-transform-types --no-warnings --import ../../scripts/local-stack/register.mjs ../../scripts/local-stack/stack.ts",
      url: `${API}/healthz`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: "ignore",
      env: {
        DOCKSIDE_STACK_DATA_DIR: dataDir,
        DOCKSIDE_ORIGIN: WEB,
        DOCKSIDE_STACK_API_PORT: String(API_PORT),
        DOCKSIDE_STACK_CONTROL_PORT: String(CONTROL_PORT),
        DOCKSIDE_RECOVERY_DELAY_MS: String(RECOVERY_DELAY_MS),
      },
    },
    {
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DOCKSIDE_API_URL: API, DOCKSIDE_RELAYER_URL: `http://127.0.0.1:${CONTROL_PORT}` },
    },
  ],
});
