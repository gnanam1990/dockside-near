import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Browser tests run the real stack: the built control API (services/api/dist, real
 * node:sqlite file in a fresh temp directory) and the production web build served by
 * `vite preview`, which proxies API paths so the page origin equals DOCKSIDE_ORIGIN.
 * Prerequisites: `pnpm run build` at the repo root and `vite build` here (the `e2e`
 * script does the latter).
 */
const API_PORT = Number(process.env["DOCKSIDE_E2E_API_PORT"] ?? 8791);
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
      command: "node ../../services/api/dist/main.js",
      url: `${API}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DOCKSIDE_DB_PATH: join(dataDir, "e2e.sqlite"),
        DOCKSIDE_ORIGIN: WEB,
        DOCKSIDE_HOST: "127.0.0.1",
        DOCKSIDE_PORT: String(API_PORT),
        DOCKSIDE_NETWORK: "near-testnet",
      },
    },
    {
      command: `pnpm exec vite preview --host 127.0.0.1 --port ${WEB_PORT}`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { DOCKSIDE_API_URL: API },
    },
  ],
});
