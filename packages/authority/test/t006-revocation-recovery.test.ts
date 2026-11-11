/**
 * T-006 — Revocation and recovery preserve history (FR-15, INV-13, NFR-02, NFR-06).
 * Revoke, rotate and recover human, ManifestAttestor and deterministic-policy service
 * keys under delay; PoP, scoped grants and isolated service custody; new signatures
 * blocked; historical verification preserved; active attestor changes require an
 * explicit dual-signed trade revision.
 */
import {
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  randomIds,
  signFor,
  type TradeTerms,
  tradeRevisionDigest,
  tradeTermsCanonical,
  tradeTermsFromJson,
} from "@dockside/core";
import { AuditLog } from "@dockside/store";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IsolatedSigner } from "../src/index.js";
import {
  type Actor,
  bootstrap,
  closeHarnesses,
  code,
  enrollHuman,
  type Harness,
  makeHarness,
  signChallenge,
} from "./helpers.js";

afterEach(closeHarnesses);

const DAY = 24 * 3600_000;
const custody = (ref: string) => ({ kind: "ISOLATED_SIGNER_PROCESS" as const, reference: ref });

interface World {
  h: Harness;
  buyerAdmin: Actor;
  buyer: Actor;
  supplier: Actor;
  inspector: Actor;
  risk: Actor;
  tradeId: string;
  attestorKey: Ed25519KeyPair;
  attestor: { enrollmentId: string; keyVersion: number };
  policyKey: Ed25519KeyPair;
  policy: { enrollmentId: string; keyVersion: number };
}

function enrollService(
  w: { h: Harness; buyerAdmin: Actor },
  capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET",
  serviceId: string,
  key: Ed25519KeyPair,
  tradeId: string | null,
) {
  const e = w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), {
    serviceId,
    capability,
    publicKey: key.publicKey,
    scope: { tradeId, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
    custody: custody(`signer://${serviceId}/v1`),
  });
  w.h.svc.proveServiceKey({
    challengeId: e.challenge.challengeId,
    signature: signFor(key.privateKey, "SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
  });
  w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 });
  return { enrollmentId: e.enrollmentId, keyVersion: 1 };
}

function world(): World {
  const h = makeHarness({ recoveryDelayMs: 2 * DAY });
  const buyerAdmin = bootstrap(h, "Acme Imports");
  const supplierAdmin = bootstrap(h, "Harbor Supply");
  const inspectAdmin = bootstrap(h, "Port Inspections");
  const buyer = enrollHuman(h, buyerAdmin, "BUYER_APPROVER");
  const risk = enrollHuman(h, buyerAdmin, "RISK_RESOLVER");
  const supplier = enrollHuman(h, supplierAdmin, "SUPPLIER_SIGNER");
  const inspector = enrollHuman(h, inspectAdmin, "INSPECTOR");
  const tradeId = randomIds.next("trd");
  const attestorKey = generateEd25519KeyPair();
  const policyKey = generateEd25519KeyPair();
  const base = { h, buyerAdmin };
  const attestor = enrollService(base, "MANIFEST_ATTEST", "manifest-attestor", attestorKey, null);
  const policy = enrollService(base, "DETERMINISTIC_POLICY_SET", "deterministic-policy", policyKey, tradeId);
  return {
    h,
    buyerAdmin,
    buyer,
    supplier,
    inspector,
    risk,
    tradeId,
    attestorKey,
    attestor,
    policyKey,
    policy,
  };
}

function terms(
  w: World,
  over: {
    revision?: number;
    predecessor?: string | null;
    attestorVersion?: number;
    attestorKey?: string;
    buyerKey?: { id: string; pk: string };
  } = {},
): TradeTerms {
  const svc = (role: "attestor" | "policy") => {
    const isA = role === "attestor";
    return {
      enrollmentId: isA ? w.attestor.enrollmentId : w.policy.enrollmentId,
      serviceId: isA ? "manifest-attestor" : "deterministic-policy",
      keyVersion: isA ? (over.attestorVersion ?? w.attestor.keyVersion) : w.policy.keyVersion,
      publicKey: isA ? (over.attestorKey ?? w.attestorKey.publicKey) : w.policyKey.publicKey,
      capability: isA ? "MANIFEST_ATTEST" : "DETERMINISTIC_POLICY_SET",
      scope: {
        organizationId: w.buyerAdmin.organizationId,
        tradeId: isA ? null : w.tradeId,
        evidencePolicyId: "commercial-docs",
        evidencePolicyRevision: 1,
      },
      attestationSchema: isA ? "dockside/manifest-attestation@1" : "dockside/hold-set@1",
    };
  };
  const party = (a: Actor, account: string) => ({
    organizationId: a.organizationId,
    principalId: a.principalId,
    keyVersionId: a.keyVersionId,
    publicKey: a.key.publicKey,
    accountId: account,
  });
  const buyer = party(w.buyer, "acme-buyer.testnet");
  if (over.buyerKey) {
    buyer.keyVersionId = over.buyerKey.id;
    buyer.publicKey = over.buyerKey.pk as never;
  }
  return tradeTermsFromJson({
    schemaVersion: 1,
    profileVersion: "dockside-direct-testnet-v1",
    tradeId: w.tradeId,
    revision: over.revision ?? 1,
    predecessorDigest: over.predecessor ?? null,
    network: "near-testnet",
    escrowContractId: "dockside-escrow.testnet",
    buyer,
    supplier: party(w.supplier, "harbor-supplier.testnet"),
    asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
    amountYocto: "1000000000000000000000000",
    milestone: { id: "shipment-1", description: "Shipment one" },
    evidencePolicy: { id: "commercial-docs", revision: 1, digest: "ab".repeat(32) },
    inspector: {
      principalId: w.inspector.principalId,
      keyVersionId: w.inspector.keyVersionId,
      publicKey: w.inspector.key.publicKey,
      attestationSchema: "dockside/inspection-attestation@1",
    },
    manifestAttestor: svc("attestor"),
    policySetter: svc("policy"),
    riskResolver: {
      principalId: w.risk.principalId,
      keyVersionId: w.risk.keyVersionId,
      publicKey: w.risk.key.publicKey,
    },
    payout: {
      network: "near-testnet",
      recipientType: "NEAR_ACCOUNT",
      destination: "harbor-supplier.testnet",
    },
    refundPolicy: { id: "dockside-refund-v1", revision: 1 },
    delayPolicy: { destinationChangeDelayMs: DAY },
    expiresAt: w.h.clock.now() + 30 * DAY,
  });
}

const attestation = (t: TradeTerms) => ({
  tradeId: t.tradeId,
  revision: t.revision,
  manifestDigest: "cd".repeat(32),
  nonce: randomIds.next("cor"),
});

function dualSign(w: World, t: TradeTerms, buyerKey: Ed25519KeyPair = w.buyer.key) {
  const c = tradeTermsCanonical(t);
  return {
    buyerSignature: signFor(buyerKey.privateKey, "TRADE_REVISION", c),
    supplierSignature: signFor(w.supplier.key.privateKey, "TRADE_REVISION", c),
  };
}

describe("T-006 revocation and recovery preserve history", () => {
  describe("human keys", () => {
    it("revocation blocks new authority immediately but keeps historical verification", () => {
      const w = world();
      const payload = { fact: "approved", n: 1 };
      const before = w.h.clock.now();
      const sig = signFor(w.buyer.key.privateKey, "BUYER_APPROVAL", payload);
      const binding = {
        principalId: w.buyer.principalId,
        keyVersionId: w.buyer.keyVersionId,
        publicKey: w.buyer.key.publicKey,
      };
      expect(
        code(() =>
          w.h.svc.verifyPrincipalSignature({
            binding,
            capability: "BUYER_APPROVER",
            purpose: "BUYER_APPROVAL",
            payload,
            signature: sig,
          }),
        ),
      ).toBe("NO_ERROR");
      w.h.clock.advance(1000);
      w.h.svc.revokeKey(w.buyerAdmin.ctx(), { keyVersionId: w.buyer.keyVersionId, reason: "DEVICE_LOST" });
      expect(code(() => w.buyer.ctx())).toBe("KEY_REVOKED");
      expect(
        code(() =>
          w.h.svc.verifyPrincipalSignature({
            binding,
            capability: "BUYER_APPROVER",
            purpose: "BUYER_APPROVAL",
            payload,
            signature: sig,
          }),
        ),
      ).toBe("KEY_REVOKED");
      expect(
        w.h.svc.verifyHistorical({
          keyVersionId: w.buyer.keyVersionId,
          purpose: "BUYER_APPROVAL",
          payload,
          signature: sig,
          signedAt: before,
        }),
      ).toMatchObject({ valid: true, keyStatusNow: "REVOKED" });
      expect(
        w.h.svc.verifyHistorical({
          keyVersionId: w.buyer.keyVersionId,
          purpose: "BUYER_APPROVAL",
          payload,
          signature: sig,
          signedAt: w.h.clock.now(),
        }),
      ).toMatchObject({ valid: false });
      // Survives restart.
      w.h.reopen();
      expect(
        w.h.svc.verifyHistorical({
          keyVersionId: w.buyer.keyVersionId,
          purpose: "BUYER_APPROVAL",
          payload,
          signature: sig,
          signedAt: before,
        }).valid,
      ).toBe(true);
      expect(code(() => w.buyer.ctx())).toBe("KEY_REVOKED");
    });

    it("only the organization's security admin may revoke another principal's key", () => {
      const w = world();
      expect(
        code(() => w.h.svc.revokeKey(w.supplier.ctx(), { keyVersionId: w.buyer.keyVersionId, reason: "X" })),
      ).toBe("FORBIDDEN");
      expect(
        code(() => w.h.svc.revokeKey(w.buyer.ctx(), { keyVersionId: w.risk.keyVersionId, reason: "X" })),
      ).toBe("FORBIDDEN");
      // A principal may revoke its own compromised key.
      expect(
        code(() =>
          w.h.svc.revokeKey(w.risk.ctx(), { keyVersionId: w.risk.keyVersionId, reason: "COMPROMISED" }),
        ),
      ).toBe("NO_ERROR");
    });

    it("recovers a lost key only after delay, with PoP, freezing the old key meanwhile", () => {
      const w = world();
      const newKey = generateEd25519KeyPair();
      const r = w.h.svc.startRecovery(w.buyerAdmin.ctx(), {
        principalId: w.buyer.principalId,
        publicKey: newKey.publicKey,
      });
      expect(r.notBefore).toBe(w.h.clock.now() + 2 * DAY);
      // Old key frozen at once.
      expect(code(() => w.buyer.ctx())).toBe("KEY_REVOKED");
      // Completion needs PoP of the new key and the delay.
      expect(code(() => w.h.svc.completeRecovery(w.buyerAdmin.ctx(), { recoveryId: r.recoveryId }))).toBe(
        "INVALID_STATE",
      );
      w.h.svc.proveRecovery({
        challengeId: r.challenge.challengeId,
        proof: signChallenge(newKey, r.challenge),
      });
      expect(code(() => w.h.svc.completeRecovery(w.buyerAdmin.ctx(), { recoveryId: r.recoveryId }))).toBe(
        "DELAY_NOT_ELAPSED",
      );
      w.h.clock.advance(2 * DAY);
      // Admin session expired over two days; it logs in again in a fresh session.
      const c = w.h.svc.createLoginChallenge({
        principalId: w.buyerAdmin.principalId,
        publicKey: w.buyerAdmin.key.publicKey,
      });
      w.buyerAdmin.grant = w.h.svc.completeLogin({
        challengeId: c.challengeId,
        proof: signChallenge(w.buyerAdmin.key, c),
      });
      const kv = w.h.svc.completeRecovery(w.buyerAdmin.ctx(), { recoveryId: r.recoveryId });
      expect(kv).toMatchObject({ version: 2, status: "ACTIVE", publicKey: newKey.publicKey });
      const login = w.h.svc.createLoginChallenge({
        principalId: w.buyer.principalId,
        publicKey: newKey.publicKey,
      });
      const g = w.h.svc.completeLogin({
        challengeId: login.challengeId,
        proof: signChallenge(newKey, login),
      });
      expect(g.keyVersion).toBe(2);
      expect(g.capabilities).toEqual(["BUYER_APPROVER"]);
      expect(
        code(() =>
          w.h.svc.createLoginChallenge({
            principalId: w.buyer.principalId,
            publicKey: w.buyer.key.publicKey,
          }),
        ),
      ).toBe("KEY_REVOKED");
    });

    it("lets the principal veto a hostile recovery during the delay with its existing key", () => {
      const w = world();
      const attackerKey = generateEd25519KeyPair();
      const r = w.h.svc.startRecovery(w.buyerAdmin.ctx(), {
        principalId: w.buyer.principalId,
        publicKey: attackerKey.publicKey,
      });
      w.h.svc.proveRecovery({
        challengeId: r.challenge.challengeId,
        proof: signChallenge(attackerKey, r.challenge),
      });
      const veto = w.h.svc.createRecoveryCancelChallenge({ recoveryId: r.recoveryId });
      expect(
        code(() =>
          w.h.svc.cancelRecovery({ challengeId: veto.challengeId, proof: signChallenge(attackerKey, veto) }),
        ),
      ).toBe("SIGNATURE_INVALID");
      w.h.svc.cancelRecovery({ challengeId: veto.challengeId, proof: signChallenge(w.buyer.key, veto) });
      w.h.clock.advance(2 * DAY);
      const c = w.h.svc.createLoginChallenge({
        principalId: w.buyer.principalId,
        publicKey: w.buyer.key.publicKey,
      });
      expect(
        w.h.svc.completeLogin({ challengeId: c.challengeId, proof: signChallenge(w.buyer.key, c) })
          .keyVersion,
      ).toBe(1);
      expect(
        code(() =>
          w.h.svc.createLoginChallenge({
            principalId: w.buyer.principalId,
            publicKey: attackerKey.publicKey,
          }),
        ),
      ).toBe("UNAUTHENTICATED");
    });

    it("forbids an administrator from recovering its own key", () => {
      const w = world();
      const k = generateEd25519KeyPair();
      expect(
        code(() =>
          w.h.svc.startRecovery(w.buyerAdmin.ctx(), {
            principalId: w.buyerAdmin.principalId,
            publicKey: k.publicKey,
          }),
        ),
      ).toBe("SEPARATION_OF_DUTIES");
    });

    it("rotation creates a new version; the active trade revision stays bound to the old one", () => {
      const w = world();
      const t1 = terms(w);
      const newKey = generateEd25519KeyPair();
      const rc = w.h.svc.createKeyRotationChallenge(w.buyer.ctx(), { publicKey: newKey.publicKey });
      const kv = w.h.svc.completeKeyRotation(w.buyer.ctx(), {
        challengeId: rc.challengeId,
        proof: signChallenge(newKey, rc),
      });
      expect(kv.version).toBe(2);
      // The revision bound to v1 still verifies with the v1 key (no silent substitution)...
      expect(w.h.svc.verifyTradeRevisionAcceptance(t1, dualSign(w, t1)).ok).toBe(true);
      // ...and a v2 signature cannot satisfy the v1 binding.
      expect(code(() => w.h.svc.verifyTradeRevisionAcceptance(t1, dualSign(w, t1, newKey)))).toBe(
        "SIGNATURE_INVALID",
      );
      // Using v2 needs an explicit successor revision dual-signed by both parties.
      const t2 = terms(w, {
        revision: 2,
        predecessor: tradeRevisionDigest(t1),
        buyerKey: { id: kv.id, pk: newKey.publicKey },
      });
      expect(w.h.svc.verifyTradeRevisionAcceptance(t2, dualSign(w, t2, newKey)).ok).toBe(true);
      expect(
        code(() =>
          w.h.svc.verifyTradeRevisionAcceptance(t2, {
            ...dualSign(w, t2, newKey),
            supplierSignature: dualSign(w, t2, newKey).buyerSignature,
          }),
        ),
      ).toBe("SIGNATURE_INVALID");
    });
  });

  describe("service keys (ManifestAttestor and deterministic policy)", () => {
    let signer: IsolatedSigner;
    beforeAll(async () => {
      signer = await IsolatedSigner.spawn({
        allowedPurposes: ["SERVICE_POP_CHALLENGE", "MANIFEST_ATTESTATION"],
      });
    });
    afterAll(() => signer.close());

    it("enrolls a ManifestAttestor whose private key never leaves an isolated signer process", async () => {
      const w = world();
      const e = w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), {
        serviceId: "attestor-isolated",
        capability: "MANIFEST_ATTEST",
        publicKey: signer.publicKey,
        scope: { tradeId: null, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
        custody: custody("signer://attestor-isolated/pid"),
      });
      expect(w.h.svc.getServiceEnrollment(e.enrollmentId).status).toBe("PENDING_PROOF");
      const sig = await signer.sign("SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload);
      w.h.svc.proveServiceKey({ challengeId: e.challenge.challengeId, signature: sig });
      expect(w.h.svc.getServiceEnrollment(e.enrollmentId).versions[0]?.status).toBe("PENDING_ACTIVATION");
      w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 });
      expect(w.h.svc.getServiceEnrollment(e.enrollmentId)).toMatchObject({
        status: "ACTIVE",
        capability: "MANIFEST_ATTEST",
      });
      // Least privilege at the signer: it refuses purposes outside its allowlist.
      await expect(signer.sign("HOLD_RESOLVE", { x: 1 })).rejects.toThrow(/not allowed/);
      // Nothing resembling private material is stored.
      expect(JSON.stringify(w.h.db.all("SELECT * FROM key_versions"))).not.toMatch(/PRIVATE|seed/i);
    });

    it("requires a security admin, a service capability, PoP and opaque custody metadata", () => {
      const w = world();
      const k = generateEd25519KeyPair();
      const req = {
        serviceId: "attestor-b",
        capability: "MANIFEST_ATTEST" as const,
        publicKey: k.publicKey,
        scope: { tradeId: null, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
        custody: custody("signer://attestor-b"),
      };
      expect(code(() => w.h.svc.createServiceEnrollment(w.buyer.ctx(), req))).toBe("FORBIDDEN");
      expect(
        code(() =>
          w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), {
            ...req,
            capability: "BUYER_APPROVER" as never,
          }),
        ),
      ).toBe("VALIDATION_FAILED");
      expect(
        code(() =>
          w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), {
            ...req,
            custody: custody(["-----BEGIN", "PRIVATE KEY-----"].join(" ")),
          }),
        ),
      ).toBe("VALIDATION_FAILED");
      expect(
        code(() =>
          w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), { ...req, custody: custody("4".repeat(88)) }),
        ),
      ).toBe("VALIDATION_FAILED");
      expect(
        code(() =>
          w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), {
            ...req,
            scope: {
              ...req.scope,
              organizationId:
                w.buyer.organizationId === w.buyerAdmin.organizationId
                  ? `org_${"0".repeat(32)}`
                  : w.buyer.organizationId,
            },
          }),
        ),
      ).toBe("SCOPE_MISMATCH");
      // A human key cannot double as a service key.
      expect(
        code(() =>
          w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), { ...req, publicKey: w.buyer.key.publicKey }),
        ),
      ).toBe("SEPARATION_OF_DUTIES");
      const e = w.h.svc.createServiceEnrollment(w.buyerAdmin.ctx(), req);
      // Activation before proof fails; wrong signer fails.
      expect(
        code(() =>
          w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 }),
        ),
      ).toBe("INVALID_STATE");
      const wrong = generateEd25519KeyPair();
      expect(
        code(() =>
          w.h.svc.proveServiceKey({
            challengeId: e.challenge.challengeId,
            signature: signFor(wrong.privateKey, "SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
          }),
        ),
      ).toBe("SIGNATURE_INVALID");
      // A human-domain signature is not a service PoP.
      expect(
        code(() =>
          w.h.svc.proveServiceKey({
            challengeId: e.challenge.challengeId,
            signature: signFor(k.privateKey, "POP_CHALLENGE", e.challenge.canonicalPayload),
          }),
        ),
      ).toBe("WRONG_DOMAIN");
      w.h.svc.proveServiceKey({
        challengeId: e.challenge.challengeId,
        signature: signFor(k.privateKey, "SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
      });
      expect(
        code(() =>
          w.h.svc.activateServiceKey(w.buyer.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 }),
        ),
      ).toBe("FORBIDDEN");
    });

    it("rejects wrong-but-enrolled, cross-trade, cross-policy and cross-org service signatures", () => {
      const w = world();
      const t = terms(w);
      const att = attestation(t);
      const good = signFor(w.attestorKey.privateKey, "MANIFEST_ATTESTATION", att);
      expect(
        w.h.svc.verifyTradeServiceSignature(t, "manifestAttestor", "MANIFEST_ATTESTATION", att, good),
      ).toMatchObject({
        enrollmentId: w.attestor.enrollmentId,
        keyVersion: 1,
        capability: "MANIFEST_ATTEST",
      });
      // Deterministic policy service is enrolled, but not as the ManifestAttestor.
      const byPolicy = signFor(w.policyKey.privateKey, "MANIFEST_ATTESTATION", att);
      expect(
        code(() =>
          w.h.svc.verifyTradeServiceSignature(t, "manifestAttestor", "MANIFEST_ATTESTATION", att, byPolicy),
        ),
      ).toBe("SIGNATURE_INVALID");
      expect(
        code(() =>
          w.h.svc.verifyServiceSignature({
            binding: t.policySetter,
            expectedCapability: "MANIFEST_ATTEST",
            context: {
              organizationId: w.buyerAdmin.organizationId,
              tradeId: t.tradeId,
              evidencePolicyId: "commercial-docs",
              evidencePolicyRevision: 1,
            },
            purpose: "MANIFEST_ATTESTATION",
            payload: att,
            signature: byPolicy,
          }),
        ),
      ).toBe("FORBIDDEN");
      // Another ManifestAttestor enrolled only for a different trade.
      const otherKey = generateEd25519KeyPair();
      const otherTrade = randomIds.next("trd");
      const other = enrollService(w, "MANIFEST_ATTEST", "attestor-other-trade", otherKey, otherTrade);
      const otherBinding = {
        ...t.manifestAttestor,
        enrollmentId: other.enrollmentId,
        serviceId: "attestor-other-trade",
        publicKey: otherKey.publicKey,
        scope: { ...t.manifestAttestor.scope, tradeId: otherTrade },
      };
      const byOther = signFor(otherKey.privateKey, "MANIFEST_ATTESTATION", att);
      expect(
        code(() =>
          w.h.svc.verifyTradeServiceSignature(t, "manifestAttestor", "MANIFEST_ATTESTATION", att, byOther),
        ),
      ).toBe("SIGNATURE_INVALID");
      const ctx = {
        organizationId: w.buyerAdmin.organizationId,
        tradeId: t.tradeId,
        evidencePolicyId: "commercial-docs",
        evidencePolicyRevision: 1,
      };
      expect(
        code(() =>
          w.h.svc.verifyServiceSignature({
            binding: otherBinding as never,
            expectedCapability: "MANIFEST_ATTEST",
            context: ctx,
            purpose: "MANIFEST_ATTESTATION",
            payload: att,
            signature: byOther,
          }),
        ),
      ).toBe("SCOPE_MISMATCH");
      // Same attestor, but the context names a different EvidencePolicy revision or organization.
      expect(
        code(() =>
          w.h.svc.verifyServiceSignature({
            binding: t.manifestAttestor,
            expectedCapability: "MANIFEST_ATTEST",
            context: { ...ctx, evidencePolicyRevision: 2 },
            purpose: "MANIFEST_ATTESTATION",
            payload: att,
            signature: good,
          }),
        ),
      ).toBe("SCOPE_MISMATCH");
      expect(
        code(() =>
          w.h.svc.verifyServiceSignature({
            binding: t.manifestAttestor,
            expectedCapability: "MANIFEST_ATTEST",
            context: { ...ctx, organizationId: w.supplier.organizationId },
            purpose: "MANIFEST_ATTESTATION",
            payload: att,
            signature: good,
          }),
        ),
      ).toBe("SCOPE_MISMATCH");
      // A binding that misstates the enrolled scope is rejected even with a valid signature.
      expect(
        code(() =>
          w.h.svc.verifyServiceSignature({
            binding: { ...t.manifestAttestor, scope: { ...t.manifestAttestor.scope, tradeId: t.tradeId } },
            expectedCapability: "MANIFEST_ATTEST",
            context: ctx,
            purpose: "MANIFEST_ATTESTATION",
            payload: att,
            signature: good,
          }),
        ),
      ).toBe("SCOPE_MISMATCH");
    });

    it("rotation does not silently change the active revision; the rotated key is unbound until a dual-signed successor", () => {
      const w = world();
      const t1 = terms(w);
      const v2Key = generateEd25519KeyPair();
      const rot = w.h.svc.rotateServiceKey(w.buyerAdmin.ctx(), {
        enrollmentId: w.attestor.enrollmentId,
        publicKey: v2Key.publicKey,
        custody: custody("signer://manifest-attestor/v2"),
      });
      expect(rot.keyVersion).toBe(2);
      w.h.svc.proveServiceKey({
        challengeId: rot.challenge.challengeId,
        signature: signFor(v2Key.privateKey, "SERVICE_POP_CHALLENGE", rot.challenge.canonicalPayload),
      });
      w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), {
        enrollmentId: w.attestor.enrollmentId,
        keyVersion: 2,
      });
      const att = attestation(t1);
      // v1 still authoritative for the revision that bound it.
      expect(
        code(() =>
          w.h.svc.verifyTradeServiceSignature(
            t1,
            "manifestAttestor",
            "MANIFEST_ATTESTATION",
            att,
            signFor(w.attestorKey.privateKey, "MANIFEST_ATTESTATION", att),
          ),
        ),
      ).toBe("NO_ERROR");
      // Rotated-unbound: v2 cannot sign for t1, even if the caller claims v2 in a forged binding.
      const byV2 = signFor(v2Key.privateKey, "MANIFEST_ATTESTATION", att);
      expect(
        code(() =>
          w.h.svc.verifyTradeServiceSignature(t1, "manifestAttestor", "MANIFEST_ATTESTATION", att, byV2),
        ),
      ).toBe("SIGNATURE_INVALID");
      expect(
        code(() =>
          w.h.svc.verifyServiceSignature({
            binding: { ...t1.manifestAttestor, keyVersion: 2, publicKey: w.attestorKey.publicKey },
            expectedCapability: "MANIFEST_ATTEST",
            context: {
              organizationId: w.buyerAdmin.organizationId,
              tradeId: t1.tradeId,
              evidencePolicyId: "commercial-docs",
              evidencePolicyRevision: 1,
            },
            purpose: "MANIFEST_ATTESTATION",
            payload: att,
            signature: byV2,
          }),
        ),
      ).toBe("KEY_NOT_BOUND");
      expect(w.h.svc.bindingStatus(t1)).toMatchObject({ current: false });
      expect(w.h.svc.bindingStatus(t1).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "manifestAttestor", code: "KEY_SUPERSEDED" }),
        ]),
      );
      // Successor revision binding v2: must be dual-signed.
      const t2 = terms(w, {
        revision: 2,
        predecessor: tradeRevisionDigest(t1),
        attestorVersion: 2,
        attestorKey: v2Key.publicKey,
      });
      const only = dualSign(w, t2);
      expect(
        code(() =>
          w.h.svc.verifyTradeRevisionAcceptance(t2, {
            buyerSignature: only.buyerSignature,
            supplierSignature: only.buyerSignature,
          }),
        ),
      ).toBe("SIGNATURE_INVALID");
      expect(w.h.svc.verifyTradeRevisionAcceptance(t2, only)).toMatchObject({
        ok: true,
        digest: tradeRevisionDigest(t2),
      });
      const att2 = attestation(t2);
      expect(
        code(() =>
          w.h.svc.verifyTradeServiceSignature(
            t2,
            "manifestAttestor",
            "MANIFEST_ATTESTATION",
            att2,
            signFor(v2Key.privateKey, "MANIFEST_ATTESTATION", att2),
          ),
        ),
      ).toBe("NO_ERROR");
      expect(w.h.svc.bindingStatus(t2)).toMatchObject({ current: true });
    });

    it("revocation blocks new service signatures, keeps history, and forces a new revision", () => {
      const w = world();
      const t1 = terms(w);
      const att = attestation(t1);
      const sig = signFor(w.policyKey.privateKey, "HOLD_SET", att);
      const signedAt = w.h.clock.now();
      expect(code(() => w.h.svc.verifyTradeServiceSignature(t1, "policySetter", "HOLD_SET", att, sig))).toBe(
        "NO_ERROR",
      );
      w.h.clock.advance(10);
      w.h.svc.revokeServiceKey(w.buyerAdmin.ctx(), {
        enrollmentId: w.policy.enrollmentId,
        keyVersion: 1,
        reason: "SIGNER_COMPROMISED",
      });
      expect(code(() => w.h.svc.verifyTradeServiceSignature(t1, "policySetter", "HOLD_SET", att, sig))).toBe(
        "KEY_REVOKED",
      );
      const kvId = w.h.svc.getServiceEnrollment(w.policy.enrollmentId).versions[0]?.id as string;
      expect(
        w.h.svc.verifyHistorical({
          keyVersionId: kvId,
          purpose: "HOLD_SET",
          payload: att,
          signature: sig,
          signedAt,
        }).valid,
      ).toBe(true);
      expect(w.h.svc.bindingStatus(t1).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "policySetter", code: "KEY_REVOKED" })]),
      );
      expect(code(() => w.h.svc.verifyTradeRevisionAcceptance(t1, dualSign(w, t1)))).toBe("KEY_REVOKED");
    });

    it("recovers a service key only after the recovery delay and suspends the old one meanwhile", () => {
      const w = world();
      const t1 = terms(w);
      const k3 = generateEd25519KeyPair();
      const rec = w.h.svc.recoverServiceKey(w.buyerAdmin.ctx(), {
        enrollmentId: w.attestor.enrollmentId,
        publicKey: k3.publicKey,
        custody: custody("signer://manifest-attestor/recovered"),
      });
      const att = attestation(t1);
      expect(
        code(() =>
          w.h.svc.verifyTradeServiceSignature(
            t1,
            "manifestAttestor",
            "MANIFEST_ATTESTATION",
            att,
            signFor(w.attestorKey.privateKey, "MANIFEST_ATTESTATION", att),
          ),
        ),
      ).toBe("KEY_REVOKED");
      w.h.svc.proveServiceKey({
        challengeId: rec.challenge.challengeId,
        signature: signFor(k3.privateKey, "SERVICE_POP_CHALLENGE", rec.challenge.canonicalPayload),
      });
      expect(
        code(() =>
          w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), {
            enrollmentId: w.attestor.enrollmentId,
            keyVersion: rec.keyVersion,
          }),
        ),
      ).toBe("DELAY_NOT_ELAPSED");
      w.h.clock.advance(2 * DAY);
      const c = w.h.svc.createLoginChallenge({
        principalId: w.buyerAdmin.principalId,
        publicKey: w.buyerAdmin.key.publicKey,
      });
      w.buyerAdmin.grant = w.h.svc.completeLogin({
        challengeId: c.challengeId,
        proof: signChallenge(w.buyerAdmin.key, c),
      });
      w.h.svc.activateServiceKey(w.buyerAdmin.ctx(), {
        enrollmentId: w.attestor.enrollmentId,
        keyVersion: rec.keyVersion,
      });
      const status = w.h.svc.getServiceEnrollment(w.attestor.enrollmentId);
      expect(status.versions.map((v) => [v.version, v.status])).toEqual([
        [1, "REVOKED"],
        [2, "ACTIVE"],
      ]);
      // Still no silent substitution: t1 binds v1 and needs a new dual-signed revision.
      expect(w.h.svc.bindingStatus(t1).current).toBe(false);
    });

    it("persists every authority event in an intact audit chain across restart", () => {
      const w = world();
      w.h.svc.revokeServiceKey(w.buyerAdmin.ctx(), {
        enrollmentId: w.policy.enrollmentId,
        keyVersion: 1,
        reason: "TEST",
      });
      w.h.reopen();
      const log = new AuditLog(w.h.db, w.h.clock, randomIds);
      const types = new Set(log.list({}, 5000).map((e) => e.eventType));
      for (const t of [
        "ORG_BOOTSTRAPPED",
        "INVITATION_CREATED",
        "INVITATION_ACCEPTED",
        "ROLE_GRANTED",
        "SERVICE_ENROLLMENT_CREATED",
        "SERVICE_KEY_PROVEN",
        "SERVICE_KEY_ACTIVATED",
        "KEY_REVOKED",
        "SESSION_CREATED",
      ]) {
        expect(types, t).toContain(t);
      }
      expect(log.verifyChain().ok).toBe(true);
      const revoked = log.list({ eventType: "KEY_REVOKED" });
      expect(revoked[0]).toMatchObject({
        actorPrincipalId: w.buyerAdmin.principalId,
        source: "authority",
        subjectType: "key_version",
      });
      expect(revoked[0]?.correlationId).toMatch(/^cor_/);
    });
  });
});
