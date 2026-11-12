// The journal worker as one OS process, composed the way the local stack and a provisioned
// deployment compose it: the compiled @dockside/worker WorkerLoop ticking the M05 OutboxWorker and
// Reconciler and the M11 AssetRecoveryEngine over one SQLite file and the production NEAR clients
// (JsonRpcNearClient to the simulated chain's JSON-RPC endpoint). Only the relayer signer is a
// stand-in (simulated envelopes, no key), because no relayer custody is provisioned in this build.
// Every boundary of either engine is reported on stdout; with DS_PAUSE_AT the process blocks there
// so the parent can kill it (SIGKILL / TerminateProcess) at exactly that point.
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { base58Encode, randomIds, systemClock } from "@dockside/core";
import {
  AssetRecoveryEngine,
  AssetRecoveryJournal,
  Journal,
  OutboxWorker,
  Reconciler,
} from "@dockside/journal";
import { EscrowContract, JsonRpcNearClient, NearTxClient, Nep141Reader } from "@dockside/near";
import { Database } from "@dockside/store";
import { WorkerLoop } from "../../dist/index.js";

const env = process.env;
const say = (s) => writeSync(1, `${s}\n`);
const pauseAt = env.DS_PAUSE_AT ?? "";
const maxMs = Number(env.DS_MAX_MS ?? "20000");
const refundOp = env.DS_REFUND_OP ?? "";
const assetOp = env.DS_ASSET_OP ?? "";
const refundStop = (env.DS_REFUND_STOP ?? "REFUNDED,FAILED").split(",");
const assetStop = (env.DS_ASSET_STOP ?? "RECOVERED,FAILED,NOT_SUBMITTED").split(",");

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

const onBoundary = (b, id) => {
  say(`BOUNDARY ${b} ${id}`);
  if (b === pauseAt) {
    say(`PAUSED ${b} ${id}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600_000);
  }
};

const db = Database.open(env.DS_DB);
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
const holder = env.DS_HOLDER ?? `worker-${process.pid}`;
const leaseTtlMs = Number(env.DS_LEASE_TTL ?? "1500");
const cfg = { holder, leaseTtlMs, baseBackoffMs: 0, maxBackoffMs: 0, watchMs: 3_600_000, onBoundary };
const signer = new SimTxSigner(env.DS_SIGNER ?? "relayer.testnet");
const journal = new Journal(db, systemClock, randomIds);
const reconciler = new Reconciler(journal, ports, cfg);
const assets = new AssetRecoveryJournal(db, systemClock, randomIds);
const loop = new WorkerLoop({
  worker: new OutboxWorker(journal, ports, signer, reconciler, cfg),
  reconciler,
  engines: [
    new AssetRecoveryEngine(assets, { ...ports, token: (c) => new Nep141Reader(rpc, c) }, signer, {
      holder,
      leaseTtlMs,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      onBoundary,
    }),
  ],
  intervalMs: 50,
  log: (line) => say(`LOG ${JSON.stringify(line)}`),
});

const started = Date.now();
say(`STARTED ${process.pid}`);
loop.start();
for (;;) {
  await new Promise((r) => setTimeout(r, 100));
  const r = refundOp ? journal.op(refundOp).state : null;
  const a = assetOp ? assets.op(assetOp).state : null;
  if ((r === null || refundStop.includes(r)) && (a === null || assetStop.includes(a))) {
    await loop.stop();
    say(`DONE ${r},${a}`);
    db.close();
    process.exit(0);
  }
  if (Date.now() - started > maxMs) {
    say(`TIMEOUT ${r},${a}`);
    process.exit(3);
  }
}
