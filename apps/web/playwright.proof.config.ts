import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * Browser suite of the proof page (site/proof, M46). It needs no local stack: the spec starts the
 * static file server of scripts/proof/serve.mjs and a server replaying recorded NEAR testnet
 * answers (scripts/proof/replay-rpc.mjs) itself, on ports 9041 and 9042 by default, and routes the
 * page's requests for the public RPC endpoints to the replay. The page under test is the committed
 * one, with its content security policy in force.
 */
const { baseURL: _baseURL, ...use } = base.use ?? {};

export default defineConfig({
  ...base,
  testDir: "./e2e-proof",
  testMatch: ["proof.spec.ts"],
  testIgnore: [],
  timeout: 60_000,
  use,
  webServer: [],
});
