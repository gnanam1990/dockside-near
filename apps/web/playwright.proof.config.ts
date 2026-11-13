import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * Browser suites of the proof page (site/proof, M46), the attack console (site/proof/attack, M53)
 * and the payment receipt page (M54). They need no local stack: each spec starts the static file
 * server of scripts/proof/serve.mjs and a server replaying recorded NEAR testnet answers
 * (scripts/proof/replay-rpc.mjs) itself (receipt: ports 9043 and 9044 by default), and routes the
 * page's requests for the public RPC endpoints to the replay. The pages under test are the
 * committed ones, with their content security policy in force.
 */
const { baseURL: _baseURL, ...use } = base.use ?? {};

export default defineConfig({
  ...base,
  testDir: "./e2e-proof",
  testMatch: ["proof.spec.ts", "attack.spec.ts", "receipt.spec.ts"],
  testIgnore: [],
  timeout: 60_000,
  use,
  webServer: [],
});
