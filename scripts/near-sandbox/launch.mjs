// Runs INSIDE a Linux container (node:22-trixie-slim; the sandbox binary needs glibc 2.38+): starts a local NEAR sandbox node (nearcore's
// sandbox build from NEAR's release bucket, checked against its pinned SHA-256 by fetch-sandbox.mjs
// and handed to the near-sandbox npm package through NEAR_SANDBOX_BIN_PATH) with one extra
// genesis account whose single full-access key is the public key given on the command line, and
// exposes its JSON-RPC on 0.0.0.0:3031 so the container's published port reaches it. Local only:
// no testnet, no mainnet, no state outside this container.
//
// usage: node launch.mjs <accountId> <ed25519:publicKey> [balanceYocto]
// (balance defaults to 10 NEAR; the M43 product suites give the root account enough to deploy the escrow)
import { createServer, connect } from "node:net";
import { GenesisAccount, Sandbox } from "near-sandbox";

const [accountId, publicKey, balanceArg] = process.argv.slice(2);
if (
  !accountId ||
  !publicKey?.startsWith("ed25519:") ||
  (balanceArg && !/^[1-9][0-9]{0,38}$/.test(balanceArg))
) {
  process.stderr.write("usage: node launch.mjs <accountId> <ed25519:publicKey> [balanceYocto]\n");
  process.exit(2);
}

// The private key stays with the test that generated it; the genesis record needs only the public key.
const balance = balanceArg ? BigInt(balanceArg) : 10n ** 25n;
const account = new GenesisAccount(accountId, publicKey, "not-provided", balance);
const sandbox = await Sandbox.start({ config: { rpcPort: 3030, additionalAccounts: [account] } });
const target = new URL(sandbox.rpcUrl);

createServer((client) => {
  const upstream = connect(Number(target.port), target.hostname);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
}).listen(3031, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ ready: true, rpc: sandbox.rpcUrl, exposed: 3031, accountId })}\n`);
});

const stop = async () => {
  await sandbox.tearDown().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
