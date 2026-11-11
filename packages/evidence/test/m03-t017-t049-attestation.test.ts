/**
 * T-049 (manifest attestation cannot be forged or stale) and T-017 (only the enrolled inspector
 * attests the current complete manifest) at the service boundary. The contract-boundary halves
 * are contract/crates/dockside-escrow-core/tests/t049_t017_t018_contract_evidence.rs and the
 * compiled-wasm suite m03-contract-wasm.test.ts.
 */
import { IsolatedSigner } from "@dockside/authority";
import { type CanonicalValue, newNonce, type TypedJson, toTypedJson } from "@dockside/core";
import { afterEach, describe, expect, it } from "vitest";
import { type Actor, closeHarnesses } from "../../authority/test/helpers.js";
import { manifestAttestationPayload, manifestDigest, policyDigest, type SlotFacts } from "../src/index.js";
import { codeOf, DAY, fillAll, HOUR, makeWorld, type World } from "./world.js";

let worlds: World[] = [];
let extraSigners: IsolatedSigner[] = [];
afterEach(() => {
  for (const w of worlds) w.close();
  for (const s of extraSigners) s.close();
  worlds = [];
  extraSigners = [];
  closeHarnesses();
});
const world = async () => {
  const w = await makeWorld();
  worlds.push(w);
  return w;
};

async function spawnAttestor(): Promise<IsolatedSigner> {
  const s = await IsolatedSigner.spawn({
    allowedPurposes: ["SERVICE_POP_CHALLENGE", "MANIFEST_ATTESTATION"],
  });
  extraSigners.push(s);
  return s;
}

/** A second, fully enrolled MANIFEST_ATTEST service in the same organization and scope. */
async function enrollOtherAttestor(w: World, admin: Actor = w.buyerAdmin, serviceId = "manifest-attestor-b") {
  const signer = await spawnAttestor();
  const e = w.h.svc.createServiceEnrollment(admin.ctx(), {
    serviceId,
    capability: "MANIFEST_ATTEST",
    publicKey: signer.publicKey,
    scope: { tradeId: null, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
    custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: `signer://${serviceId}/v1` },
  });
  w.h.svc.proveServiceKey({
    challengeId: e.challenge.challengeId,
    signature: await signer.sign("SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
  });
  w.h.svc.activateServiceKey(admin.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 });
  return { signer, enrollmentId: e.enrollmentId };
}

/** Current-manifest attestation payload (unsigned) exactly as the service would build it. */
function payloadFor(w: World, over: Record<string, CanonicalValue> = {}): Record<string, CanonicalValue> {
  const m = w.evidence.manifest(w.terms.tradeId);
  const now = w.h.clock.now();
  return {
    ...(manifestAttestationPayload(w.terms, {
      policyDigest: policyDigest(w.policy),
      manifestRevision: m.revision,
      manifestDigest: m.digest,
      slots: m.slots,
      issuedAt: now,
      expiresAt: now + HOUR,
      nonce: newNonce(),
    }) as Record<string, CanonicalValue>),
    ...over,
  };
}

const typed = (p: CanonicalValue): TypedJson => toTypedJson(p);

async function verifyCode(
  w: World,
  p: CanonicalValue,
  signer: { sign: IsolatedSigner["sign"] } = w.attestor,
) {
  const sig = await signer.sign("MANIFEST_ATTESTATION", p);
  return codeOf(() => w.evidence.verifyAttestation(w.terms.tradeId, typed(p), sig));
}

function mutateSlots(
  p: Record<string, CanonicalValue>,
  fn: (slots: SlotFacts[]) => void,
  reseal: World | null,
) {
  const slots = JSON.parse(JSON.stringify(p["slots"])) as SlotFacts[];
  fn(slots);
  const out: Record<string, CanonicalValue> = { ...p, slots: slots as unknown as CanonicalValue };
  if (reseal) out["manifestDigest"] = manifestDigest(reseal.terms, p["manifestRevision"] as number, slots);
  return out;
}

describe("T-049 manifest attestation cannot be forged or stale (service boundary)", () => {
  it("accepts only the exact bound attestor over the current complete manifest", async () => {
    const w = await world();
    await fillAll(w);
    const att = await w.evidence.attest(w.terms.tradeId, w.attestor);
    expect(w.evidence.attestationStatus(att.id)).toBe("CURRENT");
    expect(att.manifestDigest).toBe(w.evidence.manifest(w.terms.tradeId).digest);
    expect(w.evidence.currentAcceptedManifestDigest(w.terms.tradeId)).toBe(att.manifestDigest);
    // Re-presenting the same attestation is a replay.
    expect(await codeOf(() => w.evidence.verifyAttestation(w.terms.tradeId, att.typed, att.signature))).toBe(
      "NONCE_REPLAYED",
    );
  });

  it("rejects forged completeness, projections and every mutated binding or predicate", async () => {
    const w = await world();
    await fillAll(w);
    const cases: [string, Record<string, CanonicalValue>, string][] = [
      ["complete flag", payloadFor(w, { complete: true }), "UNKNOWN_FIELD"],
      [
        "projection field",
        mutateSlots(payloadFor(w), (s) => Object.assign(s[0] as object, { eligible: true }), null),
        "DIGEST_MISMATCH",
      ],
      [
        "mutated item, not resealed",
        mutateSlots(payloadFor(w), (s) => Object.assign(s[0]?.items[0] as object, { byteLength: 9 }), null),
        "DIGEST_MISMATCH",
      ],
      [
        "mutated item, resealed",
        mutateSlots(payloadFor(w), (s) => Object.assign(s[0]?.items[0] as object, { byteLength: 9 }), w),
        "STALE_MANIFEST",
      ],
      ["missing slot", mutateSlots(payloadFor(w), (s) => s.pop(), null), "DIGEST_MISMATCH"],
      ["manifest revision", payloadFor(w, { manifestRevision: 2 }), "STALE_MANIFEST"],
      ["manifest digest", payloadFor(w, { manifestDigest: "55".repeat(32) }), "STALE_MANIFEST"],
      ["policy revision", payloadFor(w, { evidencePolicyRevision: 2 }), "POLICY_MISMATCH"],
      ["policy digest", payloadFor(w, { evidencePolicyDigest: "44".repeat(32) }), "POLICY_MISMATCH"],
      ["schema", payloadFor(w, { schema: "dockside/manifest-attestation@2" }), "UNSUPPORTED_VERSION"],
      ["network", payloadFor(w, { network: "near-mainnet" }), "WRONG_NETWORK"],
      ["trade revision", payloadFor(w, { tradeRevision: 2 }), "STALE_REVISION"],
      ["cross-trade", payloadFor(w, { tradeId: "trd_00000000000000000000000000000000" }), "SCOPE_MISMATCH"],
      ["cross-org", payloadFor(w, { organizationId: w.supplier.organizationId }), "SCOPE_MISMATCH"],
      ["lifetime", payloadFor(w, { expiresAt: w.h.clock.now() + 2 * DAY }), "VALIDATION_FAILED"],
      [
        "expired",
        payloadFor(w, { issuedAt: w.h.clock.now() - 2 * HOUR, expiresAt: w.h.clock.now() - HOUR }),
        "EXPIRED",
      ],
      [
        "future",
        payloadFor(w, { issuedAt: w.h.clock.now() + HOUR, expiresAt: w.h.clock.now() + 2 * HOUR }),
        "NOT_YET_VALID",
      ],
    ];
    const attestorBlock = (over: Record<string, CanonicalValue>) => {
      const p = payloadFor(w);
      return { ...p, attestor: { ...(p["attestor"] as Record<string, CanonicalValue>), ...over } };
    };
    const scope = (over: Record<string, CanonicalValue>) => {
      const p = payloadFor(w);
      const a = p["attestor"] as Record<string, CanonicalValue>;
      return {
        ...p,
        attestor: { ...a, scope: { ...(a["scope"] as Record<string, CanonicalValue>), ...over } },
      };
    };
    cases.push(
      ["rotated key version", attestorBlock({ keyVersion: 2 }), "KEY_NOT_BOUND"],
      ["capability", attestorBlock({ capability: "DETERMINISTIC_POLICY_SET" }), "SCOPE_MISMATCH"],
      ["service id", attestorBlock({ serviceId: "deterministic-policy" }), "KEY_NOT_BOUND"],
      ["scope trade", scope({ tradeId: w.terms.tradeId }), "SCOPE_MISMATCH"],
      ["scope policy", scope({ evidencePolicyRevision: 2 }), "SCOPE_MISMATCH"],
      ["scope org", scope({ organizationId: w.supplier.organizationId }), "SCOPE_MISMATCH"],
    );
    for (const [name, p, expected] of cases) {
      expect(await verifyCode(w, p), name).toBe(expected);
    }
    // Unsigned tampering: the signature covers the original bytes.
    const p = payloadFor(w);
    const sig = await w.attestor.sign("MANIFEST_ATTESTATION", p);
    const tampered = { ...p, expiresAt: (p["expiresAt"] as number) - 1 };
    expect(await codeOf(() => w.evidence.verifyAttestation(w.terms.tradeId, typed(tampered), sig))).toBe(
      "SIGNATURE_INVALID",
    );
    expect(w.evidence.currentAttestation(w.terms.tradeId)).toBeNull();
  });

  it("a wrong-but-enrolled attestor, the policy service and a buyer key cannot attest", async () => {
    const w = await world();
    await fillAll(w);
    const other = await enrollOtherAttestor(w);
    expect(await verifyCode(w, payloadFor(w), other.signer)).toBe("SIGNATURE_INVALID");
    const p = payloadFor(w);
    const a = p["attestor"] as Record<string, CanonicalValue>;
    expect(
      await verifyCode(
        w,
        { ...p, attestor: { ...a, enrollmentId: other.enrollmentId, serviceId: "manifest-attestor-b" } },
        other.signer,
      ),
    ).toBe("KEY_NOT_BOUND");
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, other.signer))).toBe("KEY_NOT_BOUND");
    const buyerSig = w.sign(w.buyer, "MANIFEST_ATTESTATION", p);
    expect(await codeOf(() => w.evidence.verifyAttestation(w.terms.tradeId, typed(p), buyerSig))).toBe(
      "SIGNATURE_INVALID",
    );
    // An attestor the counterparty organization enrolled for the same policy scope.
    const cross = await enrollOtherAttestor(w, w.supplierAdmin, "supplier-attestor");
    expect(await verifyCode(w, payloadFor(w), cross.signer)).toBe("SIGNATURE_INVALID");
    expect(
      await verifyCode(
        w,
        {
          ...p,
          organizationId: w.supplier.organizationId,
          attestor: { ...a, enrollmentId: cross.enrollmentId, serviceId: "supplier-attestor" },
        },
        cross.signer,
      ),
    ).toBe("KEY_NOT_BOUND");
    expect(w.evidence.currentAttestation(w.terms.tradeId)).toBeNull();
  });

  it("rotation, revocation and recovery without a new trade revision all remove attestation authority", async () => {
    // Rotation: v2 is enrolled and active but unbound; v1 is superseded.
    const w = await world();
    await fillAll(w);
    const first = await w.evidence.attest(w.terms.tradeId, w.attestor);
    const v2 = await spawnAttestor();
    const rot = w.h.svc.rotateServiceKey(w.buyerAdmin.ctx(), {
      enrollmentId: w.attestorEnrollment,
      publicKey: v2.publicKey,
      custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: "signer://manifest-attestor/v2" },
    });
    w.h.svc.proveServiceKey({
      challengeId: rot.challenge.challengeId,
      signature: await v2.sign("SERVICE_POP_CHALLENGE", rot.challenge.canonicalPayload),
    });
    w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), { enrollmentId: w.attestorEnrollment, keyVersion: 2 });
    expect(w.h.svc.bindingStatus(w.terms).requiresNewRevision).toBe(true);
    expect(w.evidence.attestationStatus(first.id)).toBe("INVALIDATED");
    expect(w.evidence.currentAcceptedManifestDigest(w.terms.tradeId)).toBeNull();
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, w.attestor))).toBe("KEY_NOT_BOUND");
    expect(await codeOf(w.evidence.attest(w.terms.tradeId, v2))).toBe("KEY_NOT_BOUND");
    expect(
      await verifyCode(
        w,
        payloadFor(w, {
          attestor: { ...(payloadFor(w)["attestor"] as Record<string, CanonicalValue>), keyVersion: 2 },
        }),
        v2,
      ),
    ).toBe("KEY_NOT_BOUND");
    expect(await verifyCode(w, payloadFor(w), v2)).toBe("SIGNATURE_INVALID");

    // Revocation of the bound key.
    const w2 = await world();
    await fillAll(w2);
    const a2 = await w2.evidence.attest(w2.terms.tradeId, w2.attestor);
    w2.h.svc.revokeServiceKey(w2.buyerAdmin.ctx(), {
      enrollmentId: w2.attestorEnrollment,
      keyVersion: 1,
      reason: "KEY_COMPROMISE",
    });
    expect(w2.evidence.attestationStatus(a2.id)).toBe("INVALIDATED");
    expect(await codeOf(w2.evidence.attest(w2.terms.tradeId, w2.attestor))).toBe("KEY_REVOKED");

    // Recovery: the bound version is suspended at once; the recovered key is not bound.
    const w3 = await world();
    await fillAll(w3);
    const v3 = await spawnAttestor();
    w3.h.svc.recoverServiceKey(w3.buyerAdmin.ctx(), {
      enrollmentId: w3.attestorEnrollment,
      publicKey: v3.publicKey,
      custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: "signer://manifest-attestor/v2" },
    });
    expect(await codeOf(w3.evidence.attest(w3.terms.tradeId, w3.attestor))).toBe("KEY_REVOKED");
    expect(await codeOf(w3.evidence.attest(w3.terms.tradeId, v3))).toBe("KEY_REVOKED");
    expect(w3.evidence.currentAttestation(w3.terms.tradeId)).toBeNull();
  });
});

describe("T-017 only the enrolled inspector can attest the complete manifest (service boundary)", () => {
  it("requires a current attested manifest and the bound inspector key", async () => {
    const w = await world();
    const t = w.terms.tradeId;
    const rev = await fillAll(w);
    const m = w.evidence.manifest(t);
    // Complete but not yet attested.
    expect(await codeOf(() => w.evidence.recordInspection(t, ...w.inspect(rev, m.digest, "PASS")))).toBe(
      "MANIFEST_NOT_CURRENT",
    );
    const att = await w.evidence.attest(t, w.attestor);
    for (const by of [w.buyer, w.risk, w.supplier, w.otherInspector]) {
      expect(
        await codeOf(() =>
          w.evidence.recordInspection(t, ...w.inspect(rev, att.manifestDigest, "PASS", { by })),
        ),
      ).toBe("SIGNATURE_INVALID");
    }
    const naming = w.inspect(rev, att.manifestDigest, "PASS", {
      by: w.otherInspector,
      payloadOverrides: {
        inspectorPrincipalId: w.otherInspector.principalId,
        inspectorKeyVersionId: w.otherInspector.keyVersionId,
      },
    });
    expect(await codeOf(() => w.evidence.recordInspection(t, ...naming))).toBe("KEY_NOT_BOUND");
    expect(
      await codeOf(() =>
        w.evidence.recordInspection(t, ...w.inspect(rev, att.manifestDigest, "AUTO_PASS" as "PASS")),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      await codeOf(() => w.evidence.recordInspection(t, ...w.inspect(rev, "77".repeat(32), "PASS"))),
    ).toBe("STALE_MANIFEST");
    expect(
      await codeOf(() =>
        w.evidence.recordInspection(t, ...w.inspect(rev, att.manifestDigest, "PASS", { ttlMs: 31 * DAY })),
      ),
    ).toBe("VALIDATION_FAILED");
    const good = w.inspect(rev, att.manifestDigest, "PASS");
    const ins = w.evidence.recordInspection(t, ...good);
    expect(w.evidence.currentInspection(t)).toMatchObject({
      id: ins.id,
      decision: "PASS",
      attestationId: att.id,
    });
    expect(await codeOf(() => w.evidence.recordInspection(t, ...good))).toBe("NONCE_REPLAYED");
    // Once the attestation expires, neither the old decision nor a new one counts.
    w.h.clock.advance(DAY);
    expect(w.evidence.currentInspection(t)).toBeNull();
    expect(
      await codeOf(() => w.evidence.recordInspection(t, ...w.inspect(rev, att.manifestDigest, "FAIL"))),
    ).toBe("MANIFEST_NOT_CURRENT");
  });

  it("a revoked inspector key loses its decision and cannot attest again", async () => {
    const w = await world();
    const t = w.terms.tradeId;
    const rev = await fillAll(w);
    const att = await w.evidence.attest(t, w.attestor);
    w.evidence.recordInspection(t, ...w.inspect(rev, att.manifestDigest, "PASS"));
    w.h.svc.revokeKey(w.inspector.ctx(), {
      keyVersionId: w.inspector.keyVersionId,
      reason: "KEY_COMPROMISE",
    });
    expect(w.evidence.currentInspection(t)).toBeNull();
    expect(
      await codeOf(() => w.evidence.recordInspection(t, ...w.inspect(rev, att.manifestDigest, "PASS"))),
    ).toBe("KEY_REVOKED");
  });
});
