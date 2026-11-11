// Journal worker process for the M05 process-kill tests. It runs the compiled @dockside/journal
// outbox worker and reconciler against the real SQLite file and the simulated chain's JSON-RPC
// endpoint, exactly as a deployed worker would, and reports every persistence/effect boundary on
// stdout. When DS_PAUSE_AT names a boundary, the process blocks there so the parent can kill it
// at exactly that point (SIGKILL / TerminateProcess); nothing after the boundary runs.
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { base58Encode, randomIds, systemClock } from "@dockside/core";
import { EscrowContract, JsonRpcNearClient, NearTxClient } from "@dockside/near";
import { Database } from "@dockside/store";
import { Journal, OutboxWorker, Reconciler } from "../../dist/index.js";

const env = process.env;
const say = (s) => writeSync(1, `${s}\n`);
const pauseAt = env.DS_PAUSE_AT ?? "";
const stopStates = (env.DS_STOP_STATES ?? "PAID,REFUNDED,FAILED,WITHDRAWN").split(",");
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
const journal = new Journal(db, systemClock, randomIds);
const rpc = new JsonRpcNearClient({
  endpoint: env.DS_RPC,
  allowedHosts: ["127.0.0.1"],
  timeoutMs: 5000,
  maxResponseBytes: 4 * 1024 * 1024,
});
const ports = {
  escrow: new EscrowContract(rpc, env.DS_CONTRACT),
  tx: new NearTxClient(rpc),
  txValidityBlocks: Number(env.DS_VALIDITY ?? "20"),
};
const cfg = {
  holder: env.DS_HOLDER ?? `worker-${process.pid}`,
  leaseTtlMs: Number(env.DS_LEASE_TTL ?? "1500"),
  baseBackoffMs: 0,
  maxBackoffMs: 0,
  watchMs: 3_600_000,
  onBoundary(b, id) {
    say(`BOUNDARY ${b} ${id}`);
    if (b === pauseAt) {
      say(`PAUSED ${b} ${id}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
    }
  },
};
const rec = new Reconciler(journal, ports, cfg);
const worker = new OutboxWorker(
  journal,
  ports,
  new SimTxSigner(env.DS_SIGNER ?? "relayer.testnet"),
  rec,
  cfg,
);

const started = Date.now();
say(`STARTED ${process.pid}`);
for (;;) {
  await worker.runOnce();
  await rec.runOnce();
  const ops = journal.opsForTrade(env.DS_TRADE);
  if (ops.length > 0 && ops.every((o) => stopStates.includes(o.state))) {
    say(`DONE ${ops.map((o) => o.state).join(",")}`);
    db.close();
    process.exit(0);
  }
  if (Date.now() - started > maxMs) {
    say(`TIMEOUT ${ops.map((o) => o.state).join(",")}`);
    db.close();
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 100));
}
