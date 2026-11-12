/**
 * M04 test chain: the M03 world (separately enrolled principals, isolated attestor and
 * deterministic-policy signers, real uploads) plus the compiled escrow contract under the simulated
 * NEAR host (packages/near/test/sim, not nearcore) and the ReleaseService over both. Every payload
 * reaching the contract is built by the services and signed with the actors' own keys.
 */
import {
  type CanonicalValue,
  newNonce,
  randomIds,
  type SigningPurpose,
  signFor,
  type TypedJson,
  toTypedJson,
  tradeRevisionDigest,
  tradeTermsCanonical,
} from "@dockside/core";
import {
  type EvidencePolicyInput,
  inspectionPayload,
  parseEvidencePolicy,
  policyCanonical,
} from "@dockside/evidence";
import { EscrowContract, type FunctionCall, type NearRpc, termsArg } from "@dockside/near";
import { Database } from "@dockside/store";
import { expect } from "vitest";
import { type Actor, signChallenge } from "../../authority/test/helpers.js";
import { fillAll, makeWorld, type World } from "../../evidence/test/world.js";
import { type CallResult, NearSim, panicCode } from "../../near/test/sim/near-sim.js";
import { ReleaseService } from "../src/index.js";

export const CONTRACT = "dockside-escrow.testnet";
export const BUYER_ACCT = "acme-buyer.testnet";
export const TREASURY = "treasury-acme.testnet";
export const SUPPLIER_ACCT = "harbor-supplier.testnet";
export const ALT_DEST = "harbor-payouts.testnet";
export const NEAR = 10n ** 24n;
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

export class SimRpc implements NearRpc {
  constructor(
    private readonly sim: NearSim,
    private readonly now: () => number,
  ) {}
  async callView(_c: string, method: string, args: Record<string, unknown>) {
    this.sim.nowMs = this.now();
    return { value: this.sim.view(method, args) as never, logs: [], blockHeight: 1, blockHash: "sim" };
  }
  viewAccount(): never {
    throw new Error("not simulated");
  }
  viewAccessKey(): never {
    throw new Error("not simulated");
  }
  txStatus(): never {
    throw new Error("not simulated");
  }
}

export interface Chain {
  w: World;
  sim: NearSim;
  escrow: EscrowContract;
  rel: ReleaseService;
  t: string;
  exec(call: FunctionCall, predecessor?: string): CallResult;
  ok(call: FunctionCall, predecessor?: string): CallResult;
  sign(actor: Actor, purpose: SigningPurpose, payload: CanonicalValue): string;
  advance(ms: number): void;
  /** A second ReleaseService on its own database connection (two API processes). */
  second(): { rel: ReleaseService; db: Database };
}

/** Fresh PoP session after the 8h session TTL (real login challenge). */
export function relogin(a: Actor): void {
  const c = a.h.svc.createLoginChallenge({ principalId: a.principalId, publicKey: a.key.publicKey });
  a.grant = a.h.svc.completeLogin({ challengeId: c.challengeId, proof: signChallenge(a.key, c) });
}

export async function chain(opts: { policy?: EvidencePolicyInput } = {}): Promise<Chain> {
  const w = await makeWorld(opts);
  const sim = new NearSim(CONTRACT, w.h.clock.now());
  for (const a of [BUYER_ACCT, TREASURY, SUPPLIER_ACCT, "relayer.testnet"]) sim.credit(a, 1000n * NEAR);
  expect(
    sim.call("new", { network: "near-testnet", min_deposit_yocto: null }, { predecessor: CONTRACT }).ok,
  ).toBe(true);
  const escrow = new EscrowContract(new SimRpc(sim, () => w.h.clock.now()), CONTRACT);
  const exec = (call: FunctionCall, predecessor = "relayer.testnet") => {
    expect(call.receiverId).toBe(CONTRACT);
    sim.nowMs = w.h.clock.now();
    const deposit = BigInt(call.depositYocto);
    sim.credit(predecessor, -deposit);
    const r = sim.call(call.methodName, call.args, { predecessor, depositYocto: deposit });
    if (!r.ok) sim.credit(predecessor, deposit);
    return r;
  };
  const ok = (call: FunctionCall, predecessor?: string) => {
    const r = exec(call, predecessor);
    expect(r.ok, `${call.methodName}: ${r.error ?? ""}`).toBe(true);
    return r;
  };
  const c = tradeTermsCanonical(w.terms);
  ok(
    escrow.registerTradeCall(
      termsArg(w.terms),
      signFor(w.buyer.key.privateKey, "TRADE_REVISION", c),
      signFor(w.supplier.key.privateKey, "TRADE_REVISION", c),
    ),
  );
  ok(
    escrow.registerEvidencePolicyCall(
      w.terms.tradeId,
      toTypedJson(policyCanonical(parseEvidencePolicy(w.policy))),
    ),
  );
  const mk = (db: Database) =>
    new ReleaseService({
      db,
      clock: w.h.clock,
      ids: randomIds,
      authority: w.h.svc,
      evidence: w.evidence,
      holds: w.holds,
      escrow,
    });
  const rel = mk(w.h.db);
  return {
    w,
    sim,
    escrow,
    rel,
    t: w.terms.tradeId,
    exec,
    ok,
    sign: (actor, purpose, payload) => signFor(actor.key.privateKey, purpose, payload),
    advance(ms) {
      w.h.clock.advance(ms);
      if (ms >= HOUR)
        for (const a of [
          w.buyer,
          w.supplier,
          w.inspector,
          w.risk,
          w.buyerAdmin,
          w.supplierAdmin,
          w.supplierClerk,
        ])
          relogin(a);
    },
    second() {
      const db = Database.open(w.h.dbPath);
      return { rel: mk(db), db };
    },
  };
}

export function fund(c: Chain): void {
  c.ok(c.escrow.fundCall(c.t, tradeRevisionDigest(c.w.evidence.terms(c.t)), 6n * NEAR), BUYER_ACCT);
  c.ok(c.escrow.fundCall(c.t, tradeRevisionDigest(c.w.evidence.terms(c.t)), 4n * NEAR), TREASURY);
}

/** Upload, attest (isolated attestor), relay; inspect, record, relay. Returns the manifest digest. */
export async function evidenceReady(
  c: Chain,
  decision: "PASS" | "FAIL" = "PASS",
  upload = true,
): Promise<string> {
  if (upload) await fillAll(c.w);
  const att = await c.w.evidence.attest(c.t, c.w.attestor);
  c.ok(c.escrow.submitManifestAttestationCall(c.t, att.typed, att.signature));
  // Built against the bound terms so a successor revision's header is used after activation.
  const now = c.w.h.clock.now();
  const ip = inspectionPayload(c.w.evidence.terms(c.t), {
    manifestRevision: att.manifestRevision,
    manifestDigest: att.manifestDigest,
    decision,
    reasonCodes: decision === "PASS" ? ["DOCS_MATCH"] : ["DOCS_MISMATCH"],
    issuedAt: now,
    expiresAt: now + 7 * DAY,
    nonce: newNonce(),
  });
  const isig = signFor(c.w.inspector.key.privateKey, "INSPECTION_ATTESTATION", ip);
  c.w.evidence.recordInspection(c.t, ip, isig);
  c.ok(c.escrow.submitInspectionCall(c.t, toTypedJson(ip), isig));
  return att.manifestDigest;
}

export async function lockIntent(c: Chain, key = "intent-key-0001"): Promise<string> {
  const p = await c.rel.prepareIntent(c.w.buyer.ctx(), { tradeId: c.t, idempotencyKey: key });
  const sig = c.sign(c.w.buyer, "RELEASE_INTENT", p.payload);
  c.ok(c.rel.recordIntentSignature(c.w.buyer.ctx(), { releaseIntentId: p.releaseIntentId, signature: sig }));
  await c.rel.sync(c.t);
  return p.releaseIntentId;
}

export async function approve(c: Chain, id: string): Promise<void> {
  const a = await c.rel.prepareApproval(c.w.buyer.ctx(), { releaseIntentId: id });
  c.ok(
    c.rel.recordApproval(c.w.buyer.ctx(), {
      payload: a.payload,
      signature: c.sign(c.w.buyer, "BUYER_APPROVAL", a.payload),
    }),
  );
  await c.rel.sync(c.t);
}

export async function dualCancel(c: Chain, id: string): Promise<CallResult> {
  const cancel = await c.rel.prepareCancel(c.w.supplier.ctx(), {
    releaseIntentId: id,
    reasonCode: "PARTIES_AGREE",
  });
  let last: CallResult | null = null;
  for (const a of [c.w.supplier, c.w.buyer]) {
    const k = await c.rel.prepareCancelConsent(a.ctx(), cancel.payload);
    last = c.ok(
      await c.rel.recordCancelConsent(a.ctx(), {
        cancel: cancel.payload,
        consent: k.payload,
        signature: c.sign(a, "CANCEL_CONSENT", k.payload),
      }),
    );
  }
  await c.rel.sync(c.t);
  return last as CallResult;
}

export async function codeOfAsync(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? `FOREIGN:${(e as Error).message}`;
  }
}

export type { TypedJson };
export { panicCode };
