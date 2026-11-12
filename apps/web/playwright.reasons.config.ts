import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { RECOVERY_DELAY_MS } from "./e2e/stack";
import base from "./playwright.config";

/**
 * The refund-reason and race browser tests (M15) run against their OWN local stack. TRADE_EXPIRY,
 * INSPECTION_FAIL and PERMANENT_HOLD have 24- and 48-hour contract windows that cannot be
 * shortened, so the test moves the SIMULATED chain clock forward (`/control/chain-time`) twice,
 * after every step that needs a non-refund payload. The refund routes prepare their windows on
 * the contract clock, so refund steps keep working once the chain runs ahead; a dedicated stack
 * keeps the main suite's chain clock untouched. The policy's attestation lifetime is four days
 * (DOCKSIDE_STACK_ATTESTATION_LIFETIME_MS) so an inspector FAIL stays current past its 48-hour
 * appeal window; under the default one-day lifetime the API refuses such a request up front.
 */
const API_PORT = Number(process.env["DOCKSIDE_E2E_REASONS_API_PORT"] ?? 8797);
const CONTROL_PORT = Number(process.env["DOCKSIDE_E2E_REASONS_CONTROL_PORT"] ?? 8798);
const WEB_PORT = Number(process.env["DOCKSIDE_E2E_REASONS_WEB_PORT"] ?? 4395);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
// e2e/stack.ts reads the control port from this variable in the runner and in workers.
process.env["DOCKSIDE_E2E_CONTROL_PORT"] = String(CONTROL_PORT);
const dataDir = mkdtempSync(join(tmpdir(), "dockside-e2e-reasons-"));

export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: ["refund-reasons.spec.ts"],
  testIgnore: [],
  timeout: 300_000,
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
        DOCKSIDE_DESTINATION_CHANGE_DELAY_MS: "60000",
        DOCKSIDE_STACK_ATTESTATION_LIFETIME_MS: String(4 * 24 * 3600_000),
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
