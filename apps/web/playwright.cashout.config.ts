import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * The supplier cash-out browser test (M52) runs against its OWN local stack plus a local 1Click
 * simulator (packages/payout/test/fixtures) on loopback ports. The stack's API gets a read-only
 * 1Click client pointed at the simulator; the test itself plays the supplier's own client (the real
 * quote request) and the supplier's own wallet (the deposit on the simulated chain). Nothing here
 * reaches 1Click, testnet or mainnet.
 */
const API_PORT = Number(process.env["DOCKSIDE_E2E_CASHOUT_API_PORT"] ?? 9021);
const CONTROL_PORT = Number(process.env["DOCKSIDE_E2E_CASHOUT_CONTROL_PORT"] ?? 9022);
const WEB_PORT = Number(process.env["DOCKSIDE_E2E_CASHOUT_WEB_PORT"] ?? 9023);
const SIM_PORT = Number(process.env["DOCKSIDE_E2E_CASHOUT_SIM_PORT"] ?? 9024);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const SIM = `http://127.0.0.1:${SIM_PORT}`;
// e2e/stack.ts reads the control port from this variable in the runner and in workers.
process.env["DOCKSIDE_E2E_CONTROL_PORT"] = String(CONTROL_PORT);
process.env["DOCKSIDE_E2E_ONE_CLICK_SIM_URL"] = SIM;
const dataDir = mkdtempSync(join(tmpdir(), "dockside-e2e-cashout-"));
const node =
  "node --experimental-transform-types --no-warnings --import ../../scripts/local-stack/register.mjs";

export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: ["cash-out.spec.ts"],
  testIgnore: [],
  use: { ...base.use, baseURL: WEB },
  webServer: [
    {
      command: `${node} ../../packages/payout/test/fixtures/one-click-simulator-main.ts`,
      url: `${SIM}/v0/tokens`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      env: { ONE_CLICK_SIM_PORT: String(SIM_PORT) },
    },
    {
      command: `${node} ../../scripts/local-stack/stack.ts`,
      url: `${API}/healthz`,
      reuseExistingServer: false,
      timeout: 90_000,
      stdout: "ignore",
      env: {
        DOCKSIDE_STACK_DATA_DIR: dataDir,
        DOCKSIDE_ORIGIN: WEB,
        DOCKSIDE_STACK_API_PORT: String(API_PORT),
        DOCKSIDE_STACK_CONTROL_PORT: String(CONTROL_PORT),
        DOCKSIDE_STACK_ONE_CLICK_URL: SIM,
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
