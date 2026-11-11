/**
 * M03 test world. Every party is a separately keyed principal enrolled through the real M01
 * flows (PoP bootstrap, invitation, separate-session acceptance, admin grant). The
 * ManifestAttestor and deterministic-policy services hold their keys in isolated signer child
 * processes. Nothing here writes authority rows directly.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  type CanonicalValue,
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  newNonce,
  randomIds,
  type SigningPurpose,
  signFor,
  type TradeTerms,
  tradeTermsCanonical,
  tradeTermsFromJson,
} from "@dockside/core";
import { type Actor, bootstrap, enrollHuman, type Harness, makeHarness } from "../../authority/test/helpers.js";
import { IsolatedSigner } from "@dockside/authority";
import {
  type EvidencePolicyInput,
  EvidenceService,
  HoldService,
  issuancePayload,
  LocalObjectStore,
  policyDigest,
} from "../src/index.js";

export const DAY = 24 * 3600_000;
export const HOUR = 3600_000;

export function commercialPolicy(over: Partial<EvidencePolicyInput> = {}): EvidencePolicyInput {
  const doc = (slotId: string, issuer: string, uploaders: string[], freshnessMs: number) => ({
    schema: "dockside/evidence-slot-policy@1" as const,
    slotId,
    purpose: `${slotId} for the milestone`,
    minItems: 1,
    maxItems: 1,
    allowedMime: ["application/pdf", "text/plain"],
    contentClass: "DOCUMENT",
    maxItemBytes: 65_536,
    maxAggregateBytes: 65_536,
    limits: {
      maxPages: 20,
      maxPixels: 4_000_000,
      maxDecompressedBytes: 1_048_576,
      maxDecompressionRatioPermille: 100_000,
      maxParseTimeMs: 2_000,
    },
    parserProfiles: ["dockside-sniff@1"],
    uploaderCapabilities: uploaders,
    issuerCapabilities: [issuer],
    issuedAtRequired: true,
    freshnessMs,
    replacement: "SUPERSEDE_CURRENT" as const,
    requiredDerived: [{ artifactClass: "TEXT_EXTRACT", transformProfile: "dockside-text@1" }],
  });
  return {
    schema: "dockside/evidence-policy@1",
    policyId: "commercial-docs",
    revision: 1,
    attestationLifetimeMs: DAY,
    slots: [
      doc("commercial-invoice", "SUPPLIER_SIGNER", ["SUPPLIER_SIGNER", "EVIDENCE_UPLOADER"], 30 * DAY),
      doc("inspection-report", "INSPECTOR", ["INSPECTOR"], 7 * DAY),
      {
        ...doc("cargo-photos", "INSPECTOR", ["INSPECTOR", "BUYER_APPROVER"], 30 * DAY),
        allowedMime: ["image/png", "image/jpeg"],
        contentClass: "IMAGE",
        maxItems: 2,
        maxAggregateBytes: 100_000,
        requiredDerived: [{ artifactClass: "IMAGE_METADATA", transformProfile: "dockside-image-meta@1" }],
      },
    ],
    ...over,
  };
}

/* ---------------------------- content fixtures ---------------------------- */

export function pdf(text: string, extra = ""): Uint8Array {
  const body = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 12 Tf 72 712 Td (${text}) Tj ET
endstream endobj
${extra}
%%EOF
`;
  return new TextEncoder().encode(body);
}

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A real PNG (grayscale) of the given size; `bomb` makes IDAT inflate far beyond its size. */
export function png(width: number, height: number, seed = 0): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = new Uint8Array((width + 1) * height).map((_, i) => (i * 7 + seed) & 0xff);
  const idat = deflateSync(raw);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* --------------------------------- world ---------------------------------- */

export interface World {
  h: Harness;
  dir: string;
  buyerAdmin: Actor;
  supplierAdmin: Actor;
  buyer: Actor;
  supplier: Actor;
  inspector: Actor;
  risk: Actor;
  supplierClerk: Actor;
  outsiderClerk: Actor;
  otherInspector: Actor;
  attestor: IsolatedSigner;
  attestorEnrollment: string;
  policySigner: IsolatedSigner;
  policyEnrollment: string;
  policy: EvidencePolicyInput;
  terms: TradeTerms;
  evidence: EvidenceService;
  holds: HoldService;
  signers: IsolatedSigner[];
  issue(actor: Actor, capability: string, slotId: string, content: Uint8Array, issuedAt?: number): {
    capability: string;
    issuedAt: number;
    signature: string;
  };
  sign(actor: Actor, purpose: SigningPurpose, payload: CanonicalValue): string;
  close(): void;
}

async function enrollService(
  h: Harness,
  admin: Actor,
  capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET",
  serviceId: string,
  purposes: SigningPurpose[],
  tradeId: string | null,
): Promise<{ signer: IsolatedSigner; enrollmentId: string }> {
  const signer = await IsolatedSigner.spawn({ allowedPurposes: ["SERVICE_POP_CHALLENGE", ...purposes] });
  const e = h.svc.createServiceEnrollment(admin.ctx(), {
    serviceId,
    capability,
    publicKey: signer.publicKey,
    scope: { tradeId, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
    custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: `signer://${serviceId}/v1` },
  });
  h.svc.proveServiceKey({
    challengeId: e.challenge.challengeId,
    signature: await signer.sign("SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
  });
  h.svc.activateServiceKey(admin.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 });
  return { signer, enrollmentId: e.enrollmentId };
}

export async function makeWorld(opts: { policy?: EvidencePolicyInput } = {}): Promise<World> {
  const h = makeHarness();
  const dir = mkdtempSync(join(tmpdir(), "dockside-evidence-"));
  const buyerAdmin = bootstrap(h, "Acme Imports");
  const supplierAdmin = bootstrap(h, "Harbor Supply");
  const inspectAdmin = bootstrap(h, "Port Inspections");
  const outsiderAdmin = bootstrap(h, "Unrelated Traders");
  const buyer = enrollHuman(h, buyerAdmin, "BUYER_APPROVER");
  const risk = enrollHuman(h, buyerAdmin, "RISK_RESOLVER");
  const supplier = enrollHuman(h, supplierAdmin, "SUPPLIER_SIGNER");
  const supplierClerk = enrollHuman(h, supplierAdmin, "EVIDENCE_UPLOADER");
  const outsiderClerk = enrollHuman(h, outsiderAdmin, "EVIDENCE_UPLOADER");
  const inspector = enrollHuman(h, inspectAdmin, "INSPECTOR");
  const otherInspector = enrollHuman(h, inspectAdmin, "INSPECTOR", "Second Inspector");
  const tradeId = randomIds.next("trd");
  const att = await enrollService(h, buyerAdmin, "MANIFEST_ATTEST", "manifest-attestor", ["MANIFEST_ATTESTATION"], null);
  const pol = await enrollService(h, buyerAdmin, "DETERMINISTIC_POLICY_SET", "deterministic-policy", ["HOLD_SET"], tradeId);
  const policy = opts.policy ?? commercialPolicy();
  const party = (a: Actor, accountId: string) => ({
    organizationId: a.organizationId,
    principalId: a.principalId,
    keyVersionId: a.keyVersionId,
    publicKey: a.key.publicKey,
    accountId,
  });
  const svc = (enrollmentId: string, serviceId: string, pk: string, capability: string, scopeTrade: string | null, schema: string) => ({
    enrollmentId,
    serviceId,
    keyVersion: 1,
    publicKey: pk,
    capability,
    scope: { organizationId: buyerAdmin.organizationId, tradeId: scopeTrade, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
    attestationSchema: schema,
  });
  const terms = tradeTermsFromJson({
    schemaVersion: 1,
    profileVersion: "dockside-direct-testnet-v1",
    tradeId,
    revision: 1,
    predecessorDigest: null,
    network: "near-testnet",
    escrowContractId: "dockside-escrow.testnet",
    buyer: party(buyer, "acme-buyer.testnet"),
    supplier: party(supplier, "harbor-supplier.testnet"),
    asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
    amountYocto: (10n * 10n ** 24n).toString(),
    milestone: { id: "shipment-1", description: "Container MSCU1234565 loaded" },
    evidencePolicy: { id: "commercial-docs", revision: 1, digest: policyDigest(policy) },
    inspector: {
      principalId: inspector.principalId,
      keyVersionId: inspector.keyVersionId,
      publicKey: inspector.key.publicKey,
      attestationSchema: "dockside/inspection-attestation@1",
    },
    manifestAttestor: svc(att.enrollmentId, "manifest-attestor", att.signer.publicKey, "MANIFEST_ATTEST", null, "dockside/manifest-attestation@1"),
    policySetter: svc(pol.enrollmentId, "deterministic-policy", pol.signer.publicKey, "DETERMINISTIC_POLICY_SET", tradeId, "dockside/hold-set@1"),
    riskResolver: { principalId: risk.principalId, keyVersionId: risk.keyVersionId, publicKey: risk.key.publicKey },
    payout: { network: "near-testnet", recipientType: "NEAR_ACCOUNT", destination: "harbor-supplier.testnet" },
    refundPolicy: { id: "dockside-refund-v1", revision: 1 },
    delayPolicy: { destinationChangeDelayMs: DAY },
    expiresAt: h.clock.now() + 60 * DAY,
  });
  const objects = new LocalObjectStore(join(dir, "objects"), newNonce());
  const evidence = new EvidenceService({ db: h.db, clock: h.clock, ids: randomIds, authority: h.svc, objects });
  const holds = new HoldService({ db: h.db, clock: h.clock, ids: randomIds, authority: h.svc, evidence });
  evidence.registerPolicy(policy);
  const c = tradeTermsCanonical(terms);
  evidence.bindTrade(terms, {
    buyerSignature: signFor(buyer.key.privateKey, "TRADE_REVISION", c),
    supplierSignature: signFor(supplier.key.privateKey, "TRADE_REVISION", c),
  });
  const signers = [att.signer, pol.signer];
  return {
    h,
    dir,
    buyerAdmin,
    supplierAdmin,
    buyer,
    supplier,
    inspector,
    risk,
    supplierClerk,
    outsiderClerk,
    otherInspector,
    attestor: att.signer,
    attestorEnrollment: att.enrollmentId,
    policySigner: pol.signer,
    policyEnrollment: pol.enrollmentId,
    policy,
    terms,
    evidence,
    holds,
    signers,
    issue(actor, capability, slotId, content, issuedAt = h.clock.now() - HOUR) {
      const payload = issuancePayload({
        tradeId: terms.tradeId,
        slotId,
        content,
        issuedAt,
        issuerPrincipalId: actor.principalId,
        issuerKeyVersionId: actor.keyVersionId,
        issuerCapability: capability,
      });
      return { capability, issuedAt, signature: signFor(actor.key.privateKey, "EVIDENCE_ISSUANCE", payload) };
    },
    sign(actor, purpose, payload) {
      return signFor(actor.key.privateKey, purpose, payload);
    },
    close() {
      for (const s of signers) s.close();
    },
  };
}

/** Fill every slot with valid content through the real upload path. Returns the final manifest revision. */
export async function fillAll(w: World): Promise<number> {
  let rev = w.evidence.currentRevision(w.terms.tradeId);
  const inv = pdf("Commercial invoice INV-1 total 10 NEAR");
  rev = (
    await w.evidence.upload(w.supplier.ctx(), {
      tradeId: w.terms.tradeId,
      slotId: "commercial-invoice",
      content: inv,
      issuer: w.issue(w.supplier, "SUPPLIER_SIGNER", "commercial-invoice", inv),
      expectedManifestRevision: rev,
    })
  ).manifestRevision;
  const rep = new TextEncoder().encode("Inspection report: 12 pallets, seals intact, grade A.\n");
  rev = (
    await w.evidence.upload(w.inspector.ctx(), {
      tradeId: w.terms.tradeId,
      slotId: "inspection-report",
      content: rep,
      issuer: w.issue(w.inspector, "INSPECTOR", "inspection-report", rep),
      expectedManifestRevision: rev,
    })
  ).manifestRevision;
  const img = png(32, 16);
  rev = (
    await w.evidence.upload(w.inspector.ctx(), {
      tradeId: w.terms.tradeId,
      slotId: "cargo-photos",
      content: img,
      issuer: w.issue(w.inspector, "INSPECTOR", "cargo-photos", img),
      expectedManifestRevision: rev,
    })
  ).manifestRevision;
  return rev;
}

export async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? `FOREIGN:${(e as Error).message}`;
  }
}

export function freshKey(): Ed25519KeyPair {
  return generateEd25519KeyPair();
}
