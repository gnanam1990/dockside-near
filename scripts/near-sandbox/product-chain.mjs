// A local nearcore sandbox prepared like the NEAR testnet deployment (M43), for the real-chain
// product suites: the relayer-signer integration test (vitest) and the browser product path
// (apps/web/playwright.sandbox.config.ts). Local only: nothing here talks to testnet or mainnet.
//
// The node runs in a Linux container exactly as the M17 suite runs it (scripts/near-sandbox/
// launch.mjs, nearcore sandbox 2.13.4 pinned by SHA-256, ADR-0021) with one genesis account whose
// only key is generated here. Every other account, the escrow deployment and the relayer's
// function-call key are made by REAL transactions signed with Dockside's own NEAR transaction
// encoder (packages/near/src/near-tx.ts), the same code the production relayer signer uses:
//
//   escrow.<root>    deploy + `new` in one transaction (the reproducible wasm from .data/repro)
//   relayer.<root>   a full-access key kept here, plus a FUNCTION-CALL key restricted to the escrow
//                    written as a near-cli-rs key file (owner-only) for DOCKSIDE_RELAYER_KEY_FILE
//   buyer.<root>     the funder; its key file plays the buyer's own wallet
//   supplier.<root>  the bound payout destination
//
// Needs `pnpm run build` (imports the built packages) and Docker (inside WSL on Windows;
// DOCKSIDE_DOCKER overrides the command).
import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58Decode, base58Encode } from "../../packages/core/dist/index.js";
import {
  functionCallAction,
  JsonRpcNearClient,
  NearTxClient,
  signTransaction,
} from "../../packages/near/dist/index.js";

// Same image and launcher as services/api/test/m17-near-sandbox.test.ts (pinned by digest, ADR-0021).
const IMAGE = "node:22-trixie-slim@sha256:68c76cfad89921b927eae28ba21407475e29d0ce450afcdbe70c1532db042b64";
const SETUP = [
  "mkdir -p /work && cd /work",
  "cp /launcher/npm/package.json /launcher/npm/package-lock.json /launcher/launch.mjs .",
  "npm ci --ignore-scripts --no-audit --no-fund >/dev/null",
  "node /launcher/fetch-sandbox.mjs /work/bin >/dev/null",
].join(" && ");
export const NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;

function dockerCmd() {
  return (
    process.env.DOCKSIDE_DOCKER ||
    (process.platform === "win32" ? "wsl.exe -d Ubuntu-24.04 -u root -- docker" : "docker")
  )
    .split(" ")
    .filter(Boolean);
}

function docker(args, timeout = 180_000) {
  const d = dockerCmd();
  return spawnSync(d[0], [...d.slice(1), ...args], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
}

function enginePath(p) {
  if (!/(^|[\\/])wsl(\.exe)?$/i.test(dockerCmd()[0] ?? "")) return p;
  return p.replace(/^([A-Za-z]):\\/, (_m, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

/** A fresh Ed25519 key: KeyObject plus near-cli-rs textual forms. */
export function newKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(String(jwk.d), "base64url");
  const pub = Buffer.from(String(jwk.x), "base64url");
  return {
    privateKey,
    publicKey: `ed25519:${base58Encode(pub)}`,
    // near-cli-rs writes the 64-byte seed ++ public key form.
    secret: () => `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`,
  };
}

/** A near-cli-rs access-key file, created exclusively with owner-only permissions. */
export function writeKeyFile(path, accountId, key) {
  const doc = { account_id: accountId, public_key: key.publicKey, private_key: key.secret() };
  writeFileSync(path, `${JSON.stringify(doc)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

/** Load a near-cli-rs key file back into a signing key (the "wallet" of a party in the tests). */
export function keyFromFile(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const seed = Buffer.from(base58Decode(String(doc.private_key).slice("ed25519:".length))).subarray(0, 32);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return {
    accountId: doc.account_id,
    publicKey: doc.public_key,
    privateKey: createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
  };
}

export function rpcClient(rpcUrl, timeoutMs = 60_000) {
  return new JsonRpcNearClient({
    endpoint: rpcUrl,
    allowedHosts: ["127.0.0.1"],
    timeoutMs,
    maxResponseBytes: 4 * 1024 * 1024,
  });
}

/**
 * Start the sandbox node. Returns its loopback RPC URL, chain id, the root account and `stop()`.
 * `name` is the container name, `port` the loopback port its RPC is published on.
 */
export async function startSandbox({ name, port, root = "dockside-root.testnet", balance = 10_000n * NEAR }) {
  const rootKey = newKey();
  docker(["rm", "-f", name]);
  const launcher = enginePath(fileURLToPath(new URL("./", import.meta.url)).replace(/[\\/]$/, ""));
  const run = docker([
    "run",
    "-d",
    // tini as PID 1: with node itself as PID 1 the detached node stopped by itself after ~20 s (M43).
    "--init",
    ...(process.env.DOCKSIDE_SANDBOX_KEEP === "1" ? [] : ["--rm"]),
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:3031`,
    "-v",
    `${launcher}:/launcher:ro`,
    IMAGE,
    "sh",
    "-c",
    `${SETUP} && NEAR_SANDBOX_BIN_PATH=/work/bin/near-sandbox node launch.mjs ${root} ${rootKey.publicKey} ${balance}`,
  ]);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr || run.error?.message}`);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const tx = new NearTxClient(rpcClient(rpcUrl, 10_000));
  const deadline = Date.now() + 400_000;
  let last;
  for (;;) {
    try {
      if ((await tx.latestBlock()).height >= 3) break;
    } catch (e) {
      last = e;
    }
    const alive = docker(["ps", "-q", "-f", `name=^${name}$`], 30_000);
    if (alive.status === 0 && alive.stdout.trim() === "")
      throw new Error(`sandbox container ${name} exited before its RPC was ready`);
    if (Date.now() > deadline) {
      const logs = docker(["logs", name]);
      docker(["rm", "-f", name]);
      throw new Error(`sandbox RPC not ready: ${last?.message ?? last}\n${logs.stdout}${logs.stderr}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const status = await rpcClient(rpcUrl, 10_000).request("status", []);
  return {
    name,
    rpcUrl,
    chainId: String(status.chain_id),
    root: { accountId: root, ...rootKey },
    logs: () => {
      const l = docker(["logs", name]);
      return `${l.stdout}${l.stderr}`;
    },
    stop: () => docker(["rm", "-f", name]),
  };
}

/**
 * Sign and send one transaction (nonce from view_access_key, a final block hash), wait for FINAL.
 * Throws unless the outcome is FINAL_SUCCESS.
 */
export async function sendTx(rpcUrl, signer, receiverId, actions) {
  const client = new NearTxClient(rpcClient(rpcUrl));
  const nonce = (await client.accessKeyNonce(signer.accountId, signer.publicKey)) + 1n;
  const block = await client.latestBlock();
  const signed = signTransaction(signer.privateKey, {
    signerId: signer.accountId,
    publicKey: signer.publicKey,
    nonce,
    receiverId,
    blockHash: block.hash,
    actions,
  });
  const out = await client.send({
    txHash: signed.txHash,
    signerId: signer.accountId,
    encoded: signed.encoded,
  });
  if (out.kind !== "FINAL_SUCCESS")
    throw new Error(`${receiverId} ${actions.map((a) => a.kind).join("+")}: ${out.kind} ${out.error ?? ""}`);
  return { txHash: signed.txHash, outcome: out };
}

/** Function call from a party's own key ("wallet"), e.g. the buyer's `fund` deposit. */
export function walletCall(rpcUrl, signer, call) {
  return sendTx(rpcUrl, signer, call.receiverId, [functionCallAction(call)]);
}

/**
 * Accounts and deployment of the product suites, by real transactions. `dir` receives the relayer's
 * function-call key file and the buyer's wallet key file (owner-only, created exclusively).
 */
export async function prepareProductChain(sb, { wasm, dir }) {
  const root = sb.root;
  const sub = (n) => `${n}.${root.accountId}`;
  const accounts = {
    escrow: sub("escrow"),
    relayer: sub("relayer"),
    buyer: sub("buyer"),
    supplier: sub("supplier"),
  };
  const keys = { escrow: newKey(), relayer: newKey(), buyer: newKey(), supplier: newKey() };
  const balances = { escrow: 30n * NEAR, relayer: 20n * NEAR, buyer: 20n * NEAR, supplier: 5n * NEAR };
  const txs = {};
  for (const k of Object.keys(accounts)) {
    const r = await sendTx(sb.rpcUrl, root, accounts[k], [
      { kind: "CreateAccount" },
      { kind: "Transfer", depositYocto: balances[k] },
      { kind: "AddKey", publicKey: keys[k].publicKey, permission: { kind: "FullAccess" } },
    ]);
    txs[`create:${k}`] = r.txHash;
  }
  const escrowSigner = { accountId: accounts.escrow, ...keys.escrow };
  const deploy = await sendTx(sb.rpcUrl, escrowSigner, accounts.escrow, [
    { kind: "DeployContract", code: new Uint8Array(readFileSync(wasm)) },
    {
      kind: "FunctionCall",
      methodName: "new",
      args: new Uint8Array(Buffer.from(JSON.stringify({ network: "near-testnet", min_deposit_yocto: null }))),
      gas: 30n * TGAS,
      depositYocto: 0n,
    },
  ]);
  txs["deploy+new"] = deploy.txHash;
  // The relayer's own full-access key adds a function-call key restricted to the escrow, with an
  // allowance like the testnet relayer key (run-all): 1 NEAR, every method.
  const relayerFc = newKey();
  const addKey = await sendTx(sb.rpcUrl, { accountId: accounts.relayer, ...keys.relayer }, accounts.relayer, [
    {
      kind: "AddKey",
      publicKey: relayerFc.publicKey,
      permission: {
        kind: "FunctionCall",
        allowanceYocto: NEAR,
        receiverId: accounts.escrow,
        methodNames: [],
      },
    },
  ]);
  txs["add_key relayer"] = addKey.txHash;
  const relayerKeyFile = writeKeyFile(
    join(dir, "relayer-function-call-key.json"),
    accounts.relayer,
    relayerFc,
  );
  const relayerFullKeyFile = writeKeyFile(
    join(dir, "relayer-full-access-key.json"),
    accounts.relayer,
    keys.relayer,
  );
  const buyerKeyFile = writeKeyFile(join(dir, "buyer-wallet-key.json"), accounts.buyer, keys.buyer);
  return {
    accounts,
    txs,
    relayerKeyFile,
    relayerFullKeyFile,
    buyerKeyFile,
    relayerFcPublicKey: relayerFc.publicKey,
  };
}
