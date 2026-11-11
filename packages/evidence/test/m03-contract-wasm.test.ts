/**
 * Service -> compiled contract (dockside_escrow.wasm under the simulated NEAR host from
 * packages/near/test/sim; not nearcore). The EvidencePolicy, the ManifestAttestation signed in the
 * isolated attestor process, the inspector decision and the deterministic-policy hold are all
 * produced by the M03 services and accepted or rejected by the contract's own recomputation.
 * Owned halves: T-049, T-017, T-018 and T-016 at the direct contract boundary.
 */
import {
  type CanonicalValue,
  newNonce,
  signFor,
  type TypedJson,
  toTypedJson,
  tradeTermsCanonical,
} from "@dockside/core";
import {
  EscrowContract,
  type FunctionCall,
  holdResolvePayload,
  type NearRpc,
  termsArg,
  tradeBinding,
} from "@dockside/near";
import { afterEach, describe, expect, it } from "vitest";
import { closeHarnesses } from "../../authority/test/helpers.js";
import { type CallResult, NearSim, panicCode } from "../../near/test/sim/near-sim.js";
import { parseEvidencePolicy, policyCanonical } from "../src/index.js";
import { DAY, fillAll, HOUR, makeWorld, pdf, type World } from "./world.js";

const CONTRACT = "dockside-escrow.testnet";

class SimRpc implements NearRpc {
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

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.close();
  worlds = [];
  closeHarnesses();
});

interface Chain {
  w: World;
  sim: NearSim;
  escrow: EscrowContract;
  exec(call: FunctionCall): CallResult;
}

async function chain(): Promise<Chain> {
  const w = await makeWorld();
  worlds.push(w);
  const sim = new NearSim(CONTRACT, w.h.clock.now());
  expect(
    sim.call("new", { network: "near-testnet", min_deposit_yocto: null }, { predecessor: CONTRACT }).ok,
  ).toBe(true);
  const escrow = new EscrowContract(new SimRpc(sim, () => w.h.clock.now()), CONTRACT);
  const exec = (call: FunctionCall) => {
    sim.nowMs = w.h.clock.now();
    return sim.call(call.methodName, call.args, { predecessor: "relayer.testnet" });
  };
  const c = tradeTermsCanonical(w.terms);
  const reg = exec(
    escrow.registerTradeCall(
      termsArg(w.terms),
      signFor(w.buyer.key.privateKey, "TRADE_REVISION", c),
      signFor(w.supplier.key.privateKey, "TRADE_REVISION", c),
    ),
  );
  expect(reg.ok, reg.error ?? "").toBe(true);
  const pol = exec(
    escrow.registerEvidencePolicyCall(
      w.terms.tradeId,
      toTypedJson(policyCanonical(parseEvidencePolicy(w.policy))),
    ),
  );
  expect(pol.ok, pol.error ?? "").toBe(true);
  expect(pol.value).toBe(w.terms.evidencePolicy.digest);
  return { w, sim, escrow, exec };
}

function retype(t: TypedJson, fn: (p: Record<string, CanonicalValue>) => void): TypedJson {
  const p = JSON.parse(JSON.stringify(t)) as TypedJson;
  fn((p as { struct: Record<string, CanonicalValue> }).struct);
  return p;
}

describe("M03 services against the compiled escrow contract", () => {
  it("the contract accepts the service's attestation and inspection and derives the same manifest digest", async () => {
    const { w, escrow, exec } = await chain();
    const t = w.terms.tradeId;
    await fillAll(w);
    const att = await w.evidence.attest(t, w.attestor);
    const sub = exec(escrow.submitManifestAttestationCall(t, att.typed, att.signature));
    expect(sub.ok, sub.error ?? "").toBe(true);
    expect(sub.value).toBe(att.manifestDigest);
    const [ip, isig] = w.inspect(att.manifestRevision, att.manifestDigest, "PASS");
    w.evidence.recordInspection(t, ip, isig);
    const ins = exec(escrow.submitInspectionCall(t, toTypedJson(ip), isig));
    expect(ins.ok, ins.error ?? "").toBe(true);
    const view = await escrow.getEvidence(t);
    expect(view.current?.digest).toBe(att.manifestDigest);
    expect(view.current?.items).toEqual(w.evidence.manifest(t).items.map((i) => i.itemId));
    expect(view.usable).toBe(true);
    expect(view.currentInspectionDecision).toBe("PASS");
    expect(w.evidence.currentAcceptedManifestDigest(t)).toBe(view.current?.digest);
  });

  it("forged completeness, mutated predicates and the wrong signer are rejected by the wasm", async () => {
    const { w, escrow, exec } = await chain();
    const t = w.terms.tradeId;
    await fillAll(w);
    const att = await w.evidence.attest(t, w.attestor);
    const complete = retype(att.typed, (s) => {
      s["complete"] = { bool: true } as never;
    });
    expect(panicCode(exec(escrow.submitManifestAttestationCall(t, complete, att.signature)))).toBe(
      "UNKNOWN_FIELD",
    );
    const bytes = retype(att.typed, (s) => {
      const slots = (
        s["slots"] as unknown as {
          list: { struct: Record<string, { list: { struct: Record<string, unknown> }[] }> }[];
        }
      ).list;
      const item = slots[0]?.struct["items"]?.list[0]?.struct as Record<string, unknown>;
      item["byteLength"] = { u64: "9" };
    });
    expect(panicCode(exec(escrow.submitManifestAttestationCall(t, bytes, att.signature)))).toBe(
      "SIGNATURE_INVALID",
    );
    const buyerSig = w.sign(w.buyer, "MANIFEST_ATTESTATION", att.payload);
    expect(panicCode(exec(escrow.submitManifestAttestationCall(t, att.typed, buyerSig)))).toBe(
      "SIGNATURE_INVALID",
    );
    const policySig = await w.policySigner.sign("HOLD_SET", att.payload);
    expect(panicCode(exec(escrow.submitManifestAttestationCall(t, att.typed, policySig)))).toBe(
      "SIGNATURE_INVALID",
    );
    // Inspection before any accepted manifest.
    const [ip, isig] = w.inspect(att.manifestRevision, att.manifestDigest, "PASS");
    expect(panicCode(exec(escrow.submitInspectionCall(t, toTypedJson(ip), isig)))).toBe(
      "MANIFEST_NOT_CURRENT",
    );
    expect((await escrow.getEvidence(t)).current).toBeNull();
    // The genuine attestation still goes through once; a replay is stale.
    expect(exec(escrow.submitManifestAttestationCall(t, att.typed, att.signature)).ok).toBe(true);
    expect(panicCode(exec(escrow.submitManifestAttestationCall(t, att.typed, att.signature)))).toBe(
      "STALE_MANIFEST",
    );
    // Once the attestation lifetime passes on chain, the manifest is no longer inspectable.
    w.h.clock.advance(2 * DAY);
    expect((await escrow.getEvidence(t)).usable).toBe(false);
    expect(panicCode(exec(escrow.submitInspectionCall(t, toTypedJson(ip), isig)))).toBe(
      "MANIFEST_NOT_CURRENT",
    );
  });

  it("replacement: the new revision supersedes the old attestation and inspection on chain too", async () => {
    const { w, escrow, exec } = await chain();
    const t = w.terms.tradeId;
    const rev = await fillAll(w);
    const a1 = await w.evidence.attest(t, w.attestor);
    expect(exec(escrow.submitManifestAttestationCall(t, a1.typed, a1.signature)).ok).toBe(true);
    const [ip1, isig1] = w.inspect(a1.manifestRevision, a1.manifestDigest, "PASS");
    expect(exec(escrow.submitInspectionCall(t, toTypedJson(ip1), isig1)).ok).toBe(true);
    const old = w.evidence.manifest(t).items.find((i) => i.slotId === "commercial-invoice");
    const inv = pdf("Corrected invoice INV-1b");
    await w.evidence.upload(w.supplier.ctx(), {
      tradeId: t,
      slotId: "commercial-invoice",
      content: inv,
      issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
      replacesItemId: old?.itemId ?? "",
      expectedManifestRevision: rev,
    });
    const a2 = await w.evidence.attest(t, w.attestor);
    const sub = exec(escrow.submitManifestAttestationCall(t, a2.typed, a2.signature));
    expect(sub.ok, sub.error ?? "").toBe(true);
    const view = await escrow.getEvidence(t);
    expect(view.current?.revision).toBe(rev + 1);
    expect(view.history.map((h) => [h.revision, h.status])).toEqual([[rev, "SUPERSEDED"]]);
    expect(view.currentInspectionDecision).toBeNull();
    // The predecessor attestation cannot be replayed onto the new state.
    expect(panicCode(exec(escrow.submitManifestAttestationCall(t, a1.typed, a1.signature)))).toBe(
      "STALE_MANIFEST",
    );
    const [ip2, isig2] = w.inspect(a1.manifestRevision, a1.manifestDigest, "PASS");
    expect(panicCode(exec(escrow.submitInspectionCall(t, toTypedJson(ip2), isig2)))).toBe("STALE_MANIFEST");
  });

  it("deterministic-policy SET and risk RESOLVE produced by the services are the contract's hold records", async () => {
    const { w, escrow, exec } = await chain();
    const t = w.terms.tradeId;
    await fillAll(w);
    const att = await w.evidence.attest(t, w.attestor);
    expect(exec(escrow.submitManifestAttestationCall(t, att.typed, att.signature)).ok).toBe(true);
    const [ip, isig] = w.inspect(att.manifestRevision, att.manifestDigest, "FAIL");
    w.evidence.recordInspection(t, ip, isig);
    expect(exec(escrow.submitInspectionCall(t, toTypedJson(ip), isig)).ok).toBe(true);
    const [hold] = await w.holds.applyDeterministicPolicy(t, w.policySigner);
    expect(hold?.ruleId).toBe("inspection-fail@1");
    const set = exec(escrow.setHoldCall(t, toTypedJson(hold?.setPayload ?? null), hold?.setSignature ?? ""));
    expect(set.ok, set.error ?? "").toBe(true);
    expect(set.value).toBe(hold?.setDigest);
    const now = w.h.clock.now();
    const resolve = holdResolvePayload(tradeBinding(w.terms), {
      holdId: hold?.id ?? "",
      holdReasonCode: "INSPECTION_FAILED",
      manifestDigest: att.manifestDigest,
      resolutionCode: "RESOLVE_TO_REFUND",
      evidenceDigest: "ef".repeat(32),
      issuedAt: now,
      expiresAt: now + HOUR,
      nonce: newNonce(),
    });
    // Deterministic policy cannot resolve on chain either; the buyer cannot.
    const policySig = await w.policySigner.sign("HOLD_SET", resolve);
    expect(panicCode(exec(escrow.resolveHoldCall(t, toTypedJson(resolve), policySig)))).toBe(
      "SIGNATURE_INVALID",
    );
    expect(
      panicCode(
        exec(escrow.resolveHoldCall(t, toTypedJson(resolve), w.sign(w.buyer, "HOLD_RESOLVE", resolve))),
      ),
    ).toBe("SIGNATURE_INVALID");
    expect((await escrow.getHolds(t))[0]?.status).toBe("ACTIVE");
    const riskSig = w.sign(w.risk, "HOLD_RESOLVE", resolve);
    expect(w.holds.recordResolve(t, resolve, riskSig).status).toBe("RESOLVED");
    const res = exec(escrow.resolveHoldCall(t, toTypedJson(resolve), riskSig));
    expect(res.ok, res.error ?? "").toBe(true);
    expect((await escrow.getHolds(t))[0]?.status).toBe("RESOLVED");
  });
});
