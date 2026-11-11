/**
 * M05 test world: the M04 chain (real services, separately enrolled principals, compiled escrow
 * wasm on the simulated NEAR host) served over HTTP JSON-RPC by SimChainServer, the journal
 * service in the API role, and journal engines that reach the chain only through the production
 * `JsonRpcNearClient`, `EscrowContract` and `NearTxClient`.
 */
import { ManualClock, newNonce, randomIds, signFor, toTypedJson } from "@dockside/core";
import {
  EscrowContract,
  JsonRpcNearClient,
  NearTxClient,
  type RefundReason,
  refundRequestPayload,
  refundRevokePayload,
  type SourceBucket,
  tradeBinding,
} from "@dockside/near";
import { expect } from "vitest";
import { closeHarnesses } from "../../authority/test/helpers.js";
import { pdf } from "../../evidence/test/world.js";
import {
  approve,
  BUYER_ACCT,
  type Chain,
  CONTRACT,
  chain,
  evidenceReady,
  fund,
  HOUR,
  lockIntent,
  NEAR,
  SUPPLIER_ACCT,
  TREASURY,
} from "../../release/test/chain.js";
import {
  type ChainPorts,
  type EngineConfig,
  Journal,
  JournalService,
  OutboxWorker,
  Reconciler,
} from "../src/index.js";
import { SimChainServer, SimTxSigner } from "./sim-chain.js";

export { BUYER_ACCT, CONTRACT, HOUR, NEAR, SUPPLIER_ACCT, TREASURY };
export const RELAYER = "relayer.testnet";
export const VALIDITY = 20;

export interface JWorld {
  c: Chain;
  server: SimChainServer;
  url: string;
  jclock: ManualClock;
  svc: JournalService;
  journal: Journal;
  ports: ChainPorts;
  engine(
    holder: string,
    cfg?: Partial<EngineConfig>,
  ): { worker: OutboxWorker; rec: Reconciler; journal: Journal };
  close(): Promise<void>;
}

export function rpcFor(url: string): JsonRpcNearClient {
  return new JsonRpcNearClient({
    endpoint: url,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 5_000,
    maxResponseBytes: 4 * 1024 * 1024,
  });
}

export async function jworld(opts: { funded?: boolean; evidence?: boolean } = {}): Promise<JWorld> {
  const c = await chain();
  if (opts.funded !== false) fund(c);
  if (opts.evidence !== false && opts.funded !== false) await evidenceReady(c);
  const server = new SimChainServer(c.sim, () => c.w.h.clock.now(), { validityBlocks: VALIDITY });
  const url = await server.start();
  const jclock = new ManualClock(Date.now());
  const svc = new JournalService({
    db: c.w.h.db,
    clock: jclock,
    ids: randomIds,
    escrow: c.escrow,
    release: c.rel,
    reconciliationDeadlineMs: 10 * 60_000,
  });
  const rpc = rpcFor(url);
  const ports: ChainPorts = {
    escrow: new EscrowContract(rpc, CONTRACT),
    tx: new NearTxClient(rpc),
    txValidityBlocks: VALIDITY,
  };
  const signer = new SimTxSigner(RELAYER);
  return {
    c,
    server,
    url,
    jclock,
    svc,
    journal: svc.journal,
    ports,
    engine(holder, cfg = {}) {
      const journal = new Journal(c.w.h.db, jclock, randomIds);
      const full: EngineConfig = {
        holder,
        leaseTtlMs: 30_000,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        watchMs: 3600_000,
        ...cfg,
      };
      const rec = new Reconciler(journal, ports, full);
      return { worker: new OutboxWorker(journal, ports, signer, rec, full), rec, journal };
    },
    async close() {
      await server.stop();
      c.w.close();
      closeHarnesses();
    },
  };
}

/** Lock and approve a release intent through the real services. */
export async function approvedIntent(w: JWorld, key = "intent-key-0001"): Promise<string> {
  const id = await lockIntent(w.c, key);
  await approve(w.c, id);
  return id;
}

export async function run(w: JWorld, holder = "worker-a", rounds = 6): Promise<void> {
  const e = w.engine(holder);
  for (let i = 0; i < rounds; i++) {
    await e.worker.runOnce();
    await e.rec.runOnce();
  }
}

export function state(w: JWorld, operationId: string): string {
  return w.journal.op(operationId).state;
}

/** Native-NEAR conservation over the contract account and the escrow ledger. */
export async function ledgerOk(w: JWorld): Promise<void> {
  const l = await w.c.escrow.getLedger(w.c.t);
  expect(l.conservation).toBe(true);
}

/** Excess funding from the treasury, quarantined by the contract, returned through a refund intent. */
export async function excessRefund(
  w: JWorld,
  opts: { reason?: RefundReason; funder?: string; amount?: bigint; bucket?: SourceBucket } = {},
): Promise<string> {
  const c = w.c;
  const reason = opts.reason ?? "EXCESS_FUNDING_RETURN";
  const funder = opts.funder ?? TREASURY;
  const amount = opts.amount ?? 2n * NEAR;
  const bucket = opts.bucket ?? "QUARANTINED";
  const id = randomIds.next("rfd");
  const now = c.w.h.clock.now();
  const req = refundRequestPayload(tradeBinding(c.w.terms), {
    refundIntentId: id,
    reason,
    funder,
    amountYocto: amount,
    sourceBucket: bucket,
    initiatorRole: "FUNDER",
    issuedAt: now,
    expiresAt: now + HOUR,
    nonce: newNonce(),
  });
  const sigs =
    reason === "PARTIAL_FUNDING_RETURN"
      ? {
          buyer: c.sign(c.w.buyer, "REFUND_REQUEST", req),
          supplier: c.sign(c.w.supplier, "REFUND_REQUEST", req),
        }
      : { buyer: c.sign(c.w.buyer, "REFUND_REQUEST", req) };
  c.ok(c.escrow.requestRefundCall(c.t, toTypedJson(req), sigs), funder);
  return id;
}

export async function authorizeAfterDelay(w: JWorld, refundIntentId: string): Promise<void> {
  w.c.advance(HOUR + 1);
  w.c.ok(w.c.escrow.authorizeRefundCall(w.c.t, refundIntentId), "anyone.testnet");
}

export async function revokeAsFunder(w: JWorld, refundIntentId: string, funder = TREASURY): Promise<void> {
  const c = w.c;
  const r = (await c.escrow.getRefunds(c.t)).find((x) => x.refundIntentId === refundIntentId);
  const now = c.w.h.clock.now();
  const p = refundRevokePayload(tradeBinding(c.w.terms), {
    refundIntentId,
    requestDigest: r?.requestDigest ?? "",
    revokerRole: "FUNDER",
    issuedAt: now,
    expiresAt: now + HOUR,
    nonce: newNonce(),
  });
  c.ok(c.escrow.revokeRefundCall(c.t, toTypedJson(p), null), funder);
}

export { signFor };

/** Replace the commercial invoice: a new manifest revision for a fresh attestation. */
export async function replaceInvoice(w: JWorld, text: string): Promise<void> {
  const ev = w.c.w.evidence;
  const t = w.c.t;
  const current = ev.manifest(t).items.find((i) => i.slotId === "commercial-invoice");
  const inv = pdf(text);
  await ev.upload(w.c.w.supplier.ctx(), {
    tradeId: t,
    slotId: "commercial-invoice",
    content: inv,
    issuer: w.c.w.issue(w.c.w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
    replacesItemId: current?.itemId ?? "evi_missing",
    expectedManifestRevision: ev.currentRevision(t),
  });
}
