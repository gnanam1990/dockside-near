import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { RECOVERY_DELAY_MS } from "./e2e/stack";
import base from "./playwright.config";

/**
 * The stale-evidence browser test (M14, T-037) runs against its OWN local stack on separate ports.
 * It moves the SIMULATED trade and chain clocks a week forward (`/control/clock`) so an evidence
 * item passes its freshness deadline as both the API and the contract see it. The authority,
 * sessions and request proofs keep the wall clock. A dedicated stack keeps every other suite's
 * clocks untouched. Everything else is the same as playwright.config.
 */
const API_PORT = Number(process.env["DOCKSIDE_E2E_CLOCK_API_PORT"] ?? 8799);
const CONTROL_PORT = Number(process.env["DOCKSIDE_E2E_CLOCK_CONTROL_PORT"] ?? 8800);
const WEB_PORT = Number(process.env["DOCKSIDE_E2E_CLOCK_WEB_PORT"] ?? 4396);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
// e2e/stack.ts reads the control port from this variable in the runner and in workers.
process.env["DOCKSIDE_E2E_CONTROL_PORT"] = String(CONTROL_PORT);
const dataDir = mkdtempSync(join(tmpdir(), "dockside-e2e-clock-"));

export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: ["evidence-stale.spec.ts"],
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
