// Read-only check that a deployed escrow account runs the locally built artifact.
// For the USER to run after deploying (see README.md). Not run by the build (no network allowed).
// Usage: DOCKSIDE_NEAR_RPC_URL=https://rpc.testnet.near.org node scripts/testnet-deploy/verify-deploy.mjs <escrow>.testnet
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { base58Encode } from "../../packages/core/dist/index.js";
import { JsonRpcNearClient } from "../../packages/near/dist/index.js";

const [contractId] = process.argv.slice(2);
const endpoint = process.env.DOCKSIDE_NEAR_RPC_URL;
if (!contractId || !endpoint) {
  console.error("usage: DOCKSIDE_NEAR_RPC_URL=<https url> node verify-deploy.mjs <escrow>.testnet");
  process.exit(2);
}
if (!contractId.endsWith(".testnet")) {
  console.error("refusing: only .testnet accounts are in scope");
  process.exit(2);
}
const wasm = readFileSync(
  new URL("../../contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm", import.meta.url),
);
const localHash = base58Encode(new Uint8Array(createHash("sha256").update(wasm).digest()));
const rpc = new JsonRpcNearClient({
  endpoint,
  allowedHosts: [new URL(endpoint).hostname],
  timeoutMs: 15_000,
  maxResponseBytes: 1024 * 1024,
});
const account = await rpc.viewAccount(contractId);
const config = await rpc.callView(contractId, "get_config", {});
console.log(
  JSON.stringify(
    {
      contractId,
      localCodeHash: localHash,
      onChainCodeHash: account.codeHash,
      match: localHash === account.codeHash,
      blockHeight: account.blockHeight,
      config: config.value,
    },
    null,
    2,
  ),
);
process.exit(localHash === account.codeHash ? 0 : 1);
