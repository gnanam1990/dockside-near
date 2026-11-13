import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { WEB } from "./e2e-sandbox/runtime";

/**
 * M43 real-chain product suite: the testnet runtime profile (real API, real worker with the
 * production relayer signer, production web build) against a LOCAL nearcore sandbox running the
 * deployable escrow wasm (e2e-sandbox/runtime.ts). Opt-in, needs Docker and .data/repro:
 * `pnpm run build && pnpm run web:e2e:sandbox`. Never touches testnet.
 */
// The processes are started by the global setup, not by webServer entries.
const { webServer: _localStack, ...shared } = base;

export default defineConfig({
  ...shared,
  testDir: "./e2e-sandbox",
  testMatch: ["*.spec.ts"],
  testIgnore: [],
  timeout: 900_000,
  expect: { timeout: 30_000 },
  globalSetup: "./e2e-sandbox/runtime.ts",
  use: { ...base.use, baseURL: WEB },
});
