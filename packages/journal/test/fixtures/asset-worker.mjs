// Asset-recovery engine process for the M15 process-kill tests. It runs the compiled
// @dockside/journal AssetRecoveryEngine against the real SQLite file and the simulated chain's
// JSON-RPC endpoint (production JsonRpcNearClient, EscrowContract, NearTxClient, Nep141Reader),
// exactly as a deployed worker would, and reports every persistence/effect boundary on stdout.
// When DS_PAUSE_AT names a boundary, the process blocks there so the parent can kill it at exactly
// that point (SIGKILL / TerminateProcess); nothing after the boundary runs.
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { base58Encode, randomIds, systemClock } from "@dockside/core";
import { EscrowContract, JsonRpcNearClient, NearTxClient, Nep141Reader } from "@dockside/near";
import { Database } from "@dockside/store";
import { AssetRecoveryEngine, AssetRecoveryJournal } from "../../dist/index.js";

const env = process.env;
const say = (s) => writeSync(1, `${s}\n`);
const pauseAt = env.DS_PAUSE_AT ?? "";
const stopStates = (env.DS_STOP_STATES ?? "RECOVERED,FAILED,NOT_SUBMITTED").split(",");
const watch = (env.DS_OPS ?? "").split(",").filter(Boolean);
const maxMs = Number(env.DS_MAX_MS ?? "20000");

class SimTxSigner {
  constructor(signerId) {
    this.signerId = signerId;
    this.publicKey = `ed25519:${base58Encode(createHash("sha256").update(`sim-key:${signerId}`).digest())}`;
  }
  async sign(call, ref) {
    const envelope = {
      v: "dockside-sim-tx/1",
      signerId: this.signerId,
      publicKey: this.publicKey,
      nonce: ref.nonce.toString(10),
      blockHash: ref.blockHash,
      receiverId: call.receiverId,
      methodName: call.methodName,
      args: call.args,
      gas: call.gas,
      depositYocto: call.depositYocto,
    };
    const encoded = Buffer.from(JSON.stringify(envelope)).toString("base64");
    const txHash = base58Encode(createHash("sha256").update(Buffer.from(encoded, "base64")).digest());
    return { txHash, signerId: this.signerId, encoded };
  }
}

const db = Database.open(env.DS_DB);
const journal = new AssetRecoveryJournal(db, systemClock, randomIds);
const rpc = new JsonRpcNearClient({
  endpoint: env.DS_RPC,
  allowedHosts: ["127.0.0.1"],
  timeoutMs: 5000,
  maxResponseBytes: 4 * 1024 * 1024,
});
const ports = {
  escrow: new EscrowContract(rpc, env.DS_CONTRACT),
  tx: new NearTxClient(rpc),
  token: (c) => new Nep141Reader(rpc, c),
  txValidityBlocks: Number(env.DS_VALIDITY ?? "20"),
};
const engine = new AssetRecoveryEngine(journal, ports, new SimTxSigner(env.DS_SIGNER ?? "relayer.testnet"), {
  holder: env.DS_HOLDER ?? `asset-worker-${process.pid}`,
  leaseTtlMs: Number(env.DS_LEASE_TTL ?? "1500"),
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  onBoundary(b, id) {
    say(`BOUNDARY ${b} ${id}`);
    if (b === pauseAt) {
      say(`PAUSED ${b} ${id}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
    }
  },
});

const started = Date.now();
say(`STARTED ${process.pid}`);
for (;;) {
  await engine.runOnce();
  const states = watch.map((id) => journal.op(id).state);
  if (states.length > 0 && states.every((s) => stopStates.includes(s))) {
    say(`DONE ${states.join(",")}`);
    db.close();
    process.exit(0);
  }
  if (Date.now() - started > maxMs) {
    say(`TIMEOUT ${states.join(",")}`);
    db.close();
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 100));
}
