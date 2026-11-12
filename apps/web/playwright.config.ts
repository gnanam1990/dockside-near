import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { RECOVERY_DELAY_MS } from "./e2e/stack";

/**
 * Browser tests run the real API process with every trade module (scripts/local-stack: the
 * same createApp, a fresh SQLite file, the outbox worker and reconciler, isolated attestor and
 * policy signers) over a SIMULATED NEAR chain (compiled escrow wasm on the M02 host), and the
 * production web build served by `vite preview`, which proxies /v1, /healthz, /readyz and
 * /relay so the page origin equals DOCKSIDE_ORIGIN. The tests reach the stack's control port
 * only for administrator invitations/grants, funder wallets, chain fault switches and simulated
 * chain time.
 * Prerequisites: `pnpm run build` and `pnpm run contract:build` at the repo root, and
 * `vite build` here (the `e2e` script does the latter).
 */
const API_PORT = Number(process.env["DOCKSIDE_E2E_API_PORT"] ?? 8791);
const CONTROL_PORT = Number(process.env["DOCKSIDE_E2E_CONTROL_PORT"] ?? 8792);
const WEB_PORT = Number(process.env["DOCKSIDE_E2E_WEB_PORT"] ?? 4391);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "dockside-e2e-"));

/** Use the locally installed Chromium build when this Playwright release's own build is absent. */
function chromiumPath(): string | undefined {
  const explicit = process.env["PLAYWRIGHT_CHROMIUM_PATH"];
  if (explicit) return explicit;
  const root = process.env["LOCALAPPDATA"] ? join(process.env["LOCALAPPDATA"], "ms-playwright") : null;
  if (!root || !existsSync(root)) return undefined;
  const shells = readdirSync(root)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of shells) {
    const exe = join(root, d, "chrome-headless-shell-win64", "chrome-headless-shell.exe");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

const executablePath = chromiumPath();

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: WEB,
    browserName: "chromium",
    trace: "off",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
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
        // Short recovery delay so the browser tests can watch it hold and then elapse (default two days).
        DOCKSIDE_RECOVERY_DELAY_MS: String(RECOVERY_DELAY_MS),
        // New proposals bind a one-minute destination-change delay (the configurable minimum), so
        // the browser test waits out a real delay that the API and the contract both enforce.
        DOCKSIDE_DESTINATION_CHANGE_DELAY_MS: "60000",
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
