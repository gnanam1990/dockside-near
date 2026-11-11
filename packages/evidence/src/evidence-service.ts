import type { AuthContext, AuthorityService } from "@dockside/authority";
import {
  type CanonicalValue,
  type Clock,
  DocksideError,
  digestHexFor,
  fail,
  fromTypedJson,
  type IdGenerator,
  isDocksideError,
  newNonce,
  type SigningPurpose,
  type TradeTerms,
  type TypedJson,
  toTypedJson,
  tradeRevisionDigest,
  tradeTermsFromJson,
  tradeTermsToJson,
} from "@dockside/core";
import { AuditLog, type Database, isUniqueViolation, SqliteNonceRegistry } from "@dockside/store";
import {
  checkHeader,
  checkWindow,
  exact,
  expectStr,
  expectU64,
  isCode,
  list,
  MAX_SKEW_MS,
  nonceOf,
  type Struct,
  str,
  u64,
} from "./check.js";
import { type ObjectStore, sha256Hex } from "./objects.js";
import {
  type ItemFacts,
  issuancePayload,
  manifestAttestationPayload,
  manifestDigest,
  type SlotFacts,
} from "./payloads.js";
import {
  type EvidencePolicy,
  type EvidencePolicyInput,
  parseEvidencePolicy,
  policyCanonical,
  type SlotPolicy,
  slotPolicyDigest,
} from "./policy.js";
import { classify, isContentRejection } from "./sniff.js";

export const MAX_INSPECTION_LIFETIME_MS = 30 * 24 * 3600_000;
const SOURCE = "evidence-service";
const ATTESTATION_FIELDS = [
  "contractId",
  "network",
  "organizationId",
  "tradeId",
  "tradeRevision",
  "tradeDigest",
  "evidencePolicyId",
  "evidencePolicyRevision",
  "evidencePolicyDigest",
  "schema",
  "manifestRevision",
  "manifestDigest",
  "attestor",
  "issuedAt",
  "expiresAt",
  "nonce",
  "slots",
] as const;
const INSPECTION_FIELDS = [
  "contractId",
  "tradeId",
  "tradeRevision",
  "tradeDigest",
  "milestoneId",
  "evidencePolicyId",
  "evidencePolicyRevision",
  "manifestRevision",
  "manifestDigest",
  "decision",
  "reasonCodes",
  "inspectorPrincipalId",
  "inspectorKeyVersionId",
  "schema",
  "issuedAt",
  "expiresAt",
  "nonce",
] as const;

export interface EvidenceDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly authority: AuthorityService;
  readonly objects: ObjectStore;
}

/** A process that holds the ManifestAttestor key (isolated signer child, HSM, KMS). */
export interface AttestorSigner {
  readonly publicKey: string;
  sign(purpose: SigningPurpose, payload: CanonicalValue): Promise<string>;
}

export interface IssuerProof {
  readonly capability: string;
  readonly issuedAt: number;
  readonly signature: string;
}

export interface UploadInput {
  readonly tradeId: string;
  readonly slotId: string;
  readonly content: Uint8Array | AsyncIterable<Uint8Array>;
  readonly declaredMime?: string;
  readonly issuer: IssuerProof;
  readonly replacesItemId?: string;
  readonly expectedManifestRevision: number;
}

export interface ItemView extends ItemFacts {
  readonly slotId: string;
}

export interface ManifestView {
  readonly tradeId: string;
  readonly revision: number;
  readonly digest: string;
  readonly slots: readonly SlotFacts[];
  readonly items: readonly ItemView[];
}

export type SlotStatus = "MISSING" | "UNDERFILLED" | "STALE" | "FILLED";

export interface Evaluation {
  readonly tradeId: string;
  readonly status: "COMPLETE" | "INCOMPLETE";
  readonly manifestRevision: number;
  readonly manifestDigest: string;
  readonly policy: { readonly id: string; readonly revision: number };
  readonly slots: readonly {
    readonly slotId: string;
    readonly status: SlotStatus;
    readonly itemCount: number;
    readonly minItems: number;
    readonly maxItems: number;
    readonly freshUntil: number | null;
  }[];
}

export type AttestationStatus = "CURRENT" | "SUPERSEDED" | "EXPIRED" | "STALE" | "INVALIDATED";

export interface AttestationView {
  readonly id: string;
  readonly tradeId: string;
  readonly manifestRevision: number;
  readonly manifestDigest: string;
  readonly digest: string;
  readonly payload: CanonicalValue;
  readonly typed: TypedJson;
  readonly signature: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface InspectionView {
  readonly id: string;
  readonly tradeId: string;
  readonly attestationId: string;
  readonly manifestRevision: number;
  readonly manifestDigest: string;
  readonly decision: "PASS" | "FAIL" | "REVIEW";
  readonly reasonCodes: readonly string[];
  readonly digest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface Bound {
  readonly terms: TradeTerms;
  readonly policy: EvidencePolicy;
  readonly policyDigest: string;
}

type PartyRole = "buyer" | "supplier" | "inspector";
const PARTY_OF: Record<string, PartyRole> = {
  BUYER_APPROVER: "buyer",
  SUPPLIER_SIGNER: "supplier",
  INSPECTOR: "inspector",
};

async function readBounded(
  src: Uint8Array | AsyncIterable<Uint8Array>,
  max: number,
): Promise<{ bytes: Uint8Array } | { over: number }> {
  if (src instanceof Uint8Array) return src.length > max ? { over: src.length } : { bytes: src };
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of src) {
    if (!(c instanceof Uint8Array)) fail("VALIDATION_FAILED", "content chunks must be bytes");
    n += c.length;
    if (n > max) return { over: n };
    parts.push(c);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out };
}

/**
 * Evidence lifecycle (M03): versioned EvidencePolicy, authorized uploads with original and
 * derived digests, revisioned compare-and-swap manifests with full history, ManifestAttestor
 * attestations bound to the exact enrollment/key the signed trade revision names, and the
 * independent inspector's decision over a current attested manifest. Completeness is always
 * derived from stored facts; no caller-supplied flag is ever read.
 */
export class EvidenceService {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly authority: AuthorityService;
  readonly objectStore: ObjectStore;
  private readonly audit: AuditLog;
  private readonly nonces: SqliteNonceRegistry;

  constructor(deps: EvidenceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.authority = deps.authority;
    this.objectStore = deps.objects;
    this.audit = new AuditLog(deps.db, deps.clock, deps.ids);
    this.nonces = new SqliteNonceRegistry(deps.db, deps.clock);
  }

  /* ============================== policy & binding ============================== */

  registerPolicy(input: EvidencePolicyInput): { policyId: string; revision: number; digest: string } {
    const p = parseEvidencePolicy(input);
    const digest = digestHexFor("EVIDENCE_POLICY", policyCanonical(p));
    return this.db.transaction(() => {
      const existing = this.db.get(
        "SELECT digest FROM evidence_policies WHERE policy_id = ? AND revision = ?",
        p.policyId,
        p.revision,
      );
      if (existing) {
        if (existing["digest"] !== digest)
          fail("IMMUTABLE_FIELD", "this policy revision is already registered with different content");
        return { policyId: p.policyId, revision: p.revision, digest };
      }
      this.db.run(
        "INSERT INTO evidence_policies (policy_id, revision, digest, policy_json, registered_at) VALUES (?, ?, ?, ?, ?)",
        p.policyId,
        p.revision,
        digest,
        JSON.stringify(p),
        this.clock.now(),
      );
      this.log(null, "EVIDENCE_POLICY_REGISTERED", "evidence_policy", `${p.policyId}@${p.revision}`, {
        digest,
      });
      return { policyId: p.policyId, revision: p.revision, digest };
    });
  }

  /** Bind a trade revision that buyer and supplier accepted; it must sign the registered policy digest. */
  bindTrade(
    terms: TradeTerms,
    sigs: { buyerSignature: string; supplierSignature: string },
  ): { tradeDigest: string } {
    if (this.db.get("SELECT 1 AS x FROM evidence_trades WHERE trade_id = ?", terms.tradeId))
      fail("INVALID_STATE", "trade is already bound; a new revision needs a successor binding");
    const accepted = this.authority.verifyTradeRevisionAcceptance(terms, sigs);
    const p = this.db.get(
      "SELECT digest FROM evidence_policies WHERE policy_id = ? AND revision = ?",
      terms.evidencePolicy.id,
      terms.evidencePolicy.revision,
    );
    if (!p) fail("POLICY_MISMATCH", "the EvidencePolicy revision named by the trade is not registered");
    if (p["digest"] !== terms.evidencePolicy.digest)
      fail("POLICY_MISMATCH", "the signed trade binds a different EvidencePolicy digest");
    return this.db.transaction(() => {
      this.db.run(
        `INSERT INTO evidence_trades (trade_id, trade_revision, terms_digest, terms_json, policy_id, policy_revision, bound_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        terms.tradeId,
        terms.revision,
        accepted.digest,
        JSON.stringify(tradeTermsToJson(terms)),
        terms.evidencePolicy.id,
        terms.evidencePolicy.revision,
        this.clock.now(),
      );
      this.log(null, "EVIDENCE_TRADE_BOUND", "trade", terms.tradeId, {
        tradeDigest: accepted.digest,
        policyId: terms.evidencePolicy.id,
        policyRevision: terms.evidencePolicy.revision,
      });
      return { tradeDigest: accepted.digest };
    });
  }

  terms(tradeId: string): TradeTerms {
    return this.bound(tradeId).terms;
  }

  policyFor(tradeId: string): EvidencePolicy {
    return this.bound(tradeId).policy;
  }

  /* ================================== uploads ================================== */

  async upload(
    ctx: AuthContext,
    input: UploadInput,
  ): Promise<{ itemId: string; manifestRevision: number; manifestDigest: string; version: number }> {
    const { terms, policy } = this.bound(input.tradeId);
    const slot = this.slot(policy, input.slotId);
    const uploader = this.uploaderFor(ctx, terms, slot);
    const startRev = this.currentRevision(input.tradeId);
    if (input.expectedManifestRevision !== startRev)
      fail("VERSION_CONFLICT", "manifest changed; refresh and retry", { current: startRev });
    const slots = this.slotsAt(input.tradeId, startRev);
    const facts = this.slotFacts(slots, slot.slotId);
    let predecessor: ItemFacts | null = null;
    if (input.replacesItemId !== undefined) {
      predecessor = facts.items.find((i) => i.itemId === input.replacesItemId) ?? null;
      if (!predecessor) fail("INVALID_STATE", "replaced item is not current in this slot");
    } else if (facts.items.length >= slot.maxItems) {
      fail("OVER_CARDINALITY", "slot already holds its maximum number of items");
    }

    const read = await readBounded(input.content, slot.maxItemBytes);
    if ("over" in read) {
      this.quarantineRecord(
        input.tradeId,
        slot.slotId,
        "LIMIT_EXCEEDED",
        "item exceeds the slot byte limit",
        null,
        read.over,
        ctx,
      );
      fail("LIMIT_EXCEEDED", "item exceeds the slot byte limit");
    }
    const bytes = read.bytes;
    const originalDigest = sha256Hex(bytes);
    let classified: ReturnType<typeof classify>;
    try {
      classified = classify(bytes, slot.limits);
      if (!(slot.allowedMime as readonly string[]).includes(classified.mime))
        fail("UNSUPPORTED_CONTENT", "detected content type is not allowed for this slot", {
          detected: classified.mime,
        });
      if (classified.contentClass !== slot.contentClass)
        fail("UNSUPPORTED_CONTENT", "content class not allowed for slot");
      if (input.declaredMime !== undefined && input.declaredMime !== classified.mime)
        fail("UNSUPPORTED_CONTENT", "declared content type does not match the bytes", {
          detected: classified.mime,
        });
      const r = classified.resources;
      if (r.pages > slot.limits.maxPages || r.pixels > slot.limits.maxPixels)
        fail("LIMIT_EXCEEDED", "resource limit");
      for (const d of slot.requiredDerived) {
        if (classified.derived[d.artifactClass] === undefined)
          fail("UNSUPPORTED_CONTENT", `cannot derive ${d.artifactClass} from this content`);
      }
    } catch (e) {
      if (isDocksideError(e) && isContentRejection(e)) {
        this.quarantineRecord(
          input.tradeId,
          slot.slotId,
          e.code,
          e.message,
          originalDigest,
          bytes.length,
          ctx,
        );
      }
      throw e;
    }

    // Issuer: a bound trade party that this slot allows, vouching for exactly these bytes.
    const issuer = this.verifyIssuer(terms, slot, originalDigest, input.issuer);

    // Contiguous aggregate bound for the slot (replacement frees its predecessor's bytes).
    const aggregate =
      facts.items.reduce((a, i) => a + (i.itemId === predecessor?.itemId ? 0 : i.byteLength), 0) +
      bytes.length;
    if (aggregate > slot.maxAggregateBytes) fail("LIMIT_EXCEEDED", "slot aggregate bytes over limit");

    this.objectStore.put(bytes);
    const derived = slot.requiredDerived.map((d) => ({
      artifactClass: d.artifactClass,
      digest: this.objectStore.put(classified.derived[d.artifactClass] as Uint8Array),
      transformProfile: d.transformProfile,
      sourceDigest: originalDigest,
    }));
    const item: ItemFacts = {
      itemId: this.ids.next("evi"),
      version: predecessor ? predecessor.version + 1 : 1,
      predecessorItemId: predecessor?.itemId ?? null,
      originalDigest,
      byteLength: bytes.length,
      detectedMime: classified.mime,
      contentClass: classified.contentClass,
      resources: { ...classified.resources },
      uploader,
      issuer,
      freshUntil: issuer.issuedAt + slot.freshnessMs,
      derived,
    };
    const items = predecessor
      ? facts.items.map((i) => (i.itemId === predecessor?.itemId ? item : i))
      : [...facts.items, item];
    const r = this.commitRevision(input.tradeId, startRev, slot.slotId, items, ctx, {
      kind: predecessor ? "REPLACE" : "ADD",
      item,
      declaredMime: input.declaredMime ?? null,
    });
    return {
      itemId: item.itemId,
      manifestRevision: r.revision,
      manifestDigest: r.digest,
      version: item.version,
    };
  }

  /** Remove a current item; the uploader capability rules for its slot apply. */
  removeItem(
    ctx: AuthContext,
    input: { tradeId: string; itemId: string; expectedManifestRevision: number },
  ): { manifestRevision: number; manifestDigest: string } {
    const { terms, policy } = this.bound(input.tradeId);
    const row = this.db.get(
      "SELECT slot_id FROM evidence_items WHERE item_id = ? AND trade_id = ?",
      input.itemId,
      input.tradeId,
    );
    if (!row) fail("NOT_FOUND", "evidence item not found");
    const slot = this.slot(policy, String(row["slot_id"]));
    this.uploaderFor(ctx, terms, slot);
    const startRev = this.currentRevision(input.tradeId);
    if (input.expectedManifestRevision !== startRev)
      fail("VERSION_CONFLICT", "manifest changed; refresh and retry", { current: startRev });
    const facts = this.slotFacts(this.slotsAt(input.tradeId, startRev), slot.slotId);
    const removed = facts.items.find((i) => i.itemId === input.itemId);
    if (!removed) fail("INVALID_STATE", "item is not current in this manifest");
    const r = this.commitRevision(
      input.tradeId,
      startRev,
      slot.slotId,
      facts.items.filter((i) => i.itemId !== input.itemId),
      ctx,
      { kind: "REMOVE", item: removed, declaredMime: null },
    );
    return { manifestRevision: r.revision, manifestDigest: r.digest };
  }

  /* ================================= read model ================================ */

  currentRevision(tradeId: string): number {
    this.bound(tradeId);
    const r = this.db.get("SELECT MAX(revision) AS r FROM evidence_manifests WHERE trade_id = ?", tradeId);
    return r?.["r"] === null || r?.["r"] === undefined ? 0 : Number(r["r"]);
  }

  manifest(tradeId: string, revision?: number): ManifestView {
    const { terms } = this.bound(tradeId);
    const rev = revision ?? this.currentRevision(tradeId);
    if (rev > this.currentRevision(tradeId)) fail("NOT_FOUND", "manifest revision not found");
    const slots = this.slotsAt(tradeId, rev);
    return {
      tradeId,
      revision: rev,
      digest: manifestDigest(terms, rev, slots),
      slots,
      items: slots.flatMap((s) => s.items.map((i) => ({ ...i, slotId: s.slotId }))),
    };
  }

  history(tradeId: string): {
    revision: number;
    digest: string;
    changeKind: string;
    slotId: string;
    itemId: string;
    actorPrincipalId: string;
    createdAt: number;
  }[] {
    this.bound(tradeId);
    return this.db
      .all("SELECT * FROM evidence_manifests WHERE trade_id = ? ORDER BY revision", tradeId)
      .map((r) => ({
        revision: Number(r["revision"]),
        digest: String(r["digest"]),
        changeKind: String(r["change_kind"]),
        slotId: String(r["slot_id"]),
        itemId: String(r["item_id"]),
        actorPrincipalId: String(r["actor_principal_id"]),
        createdAt: Number(r["created_at"]),
      }));
  }

  item(itemId: string): ItemView {
    const r = this.db.get("SELECT slot_id, facts_json FROM evidence_items WHERE item_id = ?", itemId);
    if (!r) fail("NOT_FOUND", "evidence item not found");
    return { ...(JSON.parse(String(r["facts_json"])) as ItemFacts), slotId: String(r["slot_id"]) };
  }

  /** Bytes of an original or derived artifact of this trade, re-verified against its digest. */
  artifact(tradeId: string, digest: string): Uint8Array {
    const known = this.manifest(tradeId).items.some(
      (i) => i.originalDigest === digest || i.derived.some((d) => d.digest === digest),
    );
    if (!known) fail("NOT_FOUND", "artifact is not part of the current manifest");
    return this.objectStore.get(digest);
  }

  quarantine(tradeId: string): {
    id: string;
    slotId: string;
    reason: string;
    detail: string;
    originalDigest: string | null;
    observedBytes: number;
    createdAt: number;
  }[] {
    return this.db
      .all("SELECT * FROM evidence_quarantine WHERE trade_id = ? ORDER BY created_at, id", tradeId)
      .map((r) => ({
        id: String(r["id"]),
        slotId: String(r["slot_id"]),
        reason: String(r["reason"]),
        detail: String(r["detail"]),
        originalDigest: r["original_digest"] === null ? null : String(r["original_digest"]),
        observedBytes: Number(r["observed_bytes"]),
        createdAt: Number(r["created_at"]),
      }));
  }

  /** Completeness derived from the stored manifest and the clock. */
  evaluate(tradeId: string): Evaluation {
    const { terms, policy } = this.bound(tradeId);
    const rev = this.currentRevision(tradeId);
    const slots = this.slotsAt(tradeId, rev);
    const now = this.clock.now();
    const out = policy.slots.map((p) => {
      const f = this.slotFacts(slots, p.slotId);
      const freshUntil = f.items.length ? Math.min(...f.items.map((i) => i.freshUntil)) : null;
      let status: SlotStatus = "FILLED";
      if (f.items.length === 0) status = "MISSING";
      else if (freshUntil !== null && now >= freshUntil) status = "STALE";
      else if (f.items.length < p.minItems) status = "UNDERFILLED";
      return {
        slotId: p.slotId,
        status,
        itemCount: f.items.length,
        minItems: p.minItems,
        maxItems: p.maxItems,
        freshUntil,
      };
    });
    return {
      tradeId,
      status: out.every((s) => s.status === "FILLED") ? "COMPLETE" : "INCOMPLETE",
      manifestRevision: rev,
      manifestDigest: manifestDigest(terms, rev, slots),
      policy: { id: policy.policyId, revision: policy.revision },
      slots: out,
    };
  }

  /* =============================== attestation =============================== */

  /** Have the bound ManifestAttestor sign the current complete manifest, then verify and record it. */
  async attest(tradeId: string, signer: AttestorSigner): Promise<AttestationView> {
    const { terms, policy, policyDigest } = this.bound(tradeId);
    const e = this.evaluate(tradeId);
    if (e.status !== "COMPLETE")
      fail("INCOMPLETE", "manifest does not satisfy the EvidencePolicy", { revision: e.manifestRevision });
    this.requireBinding(terms, "manifestAttestor");
    if (signer.publicKey !== terms.manifestAttestor.publicKey)
      fail("KEY_NOT_BOUND", "signer is not the ManifestAttestor key bound by this trade revision");
    const now = this.clock.now();
    const minFresh = Math.min(...e.slots.map((s) => s.freshUntil ?? now));
    const slots = this.slotsAt(tradeId, e.manifestRevision);
    const payload = manifestAttestationPayload(terms, {
      policyDigest,
      manifestRevision: e.manifestRevision,
      manifestDigest: e.manifestDigest,
      slots,
      issuedAt: now,
      expiresAt: Math.min(now + policy.attestationLifetimeMs, minFresh),
      nonce: newNonce(),
    });
    const signature = await signer.sign("MANIFEST_ATTESTATION", payload);
    return this.verifyAttestation(tradeId, toTypedJson(payload), signature);
  }

  /**
   * Verify a ManifestAttestation the way the contract does (exact fields, bound attestor
   * enrollment/key/capability/scope, policy and revision, window, nonce, recomputed manifest
   * digest and derived completeness) and record it as the current attestation.
   */
  verifyAttestation(tradeId: string, typed: TypedJson, signature: string): AttestationView {
    const { terms, policy, policyDigest } = this.bound(tradeId);
    const payload = fromTypedJson(typed);
    const o = exact(payload, ATTESTATION_FIELDS, "manifest attestation");
    checkHeader(o, terms);
    expectStr(o, "network", terms.network, "WRONG_NETWORK");
    expectStr(o, "schema", "dockside/manifest-attestation@1", "UNSUPPORTED_VERSION");
    expectStr(o, "evidencePolicyId", policy.policyId, "POLICY_MISMATCH");
    expectU64(o, "evidencePolicyRevision", policy.revision, "POLICY_MISMATCH");
    expectStr(o, "evidencePolicyDigest", policyDigest, "POLICY_MISMATCH");
    const b = terms.manifestAttestor;
    const a = exact(
      o["attestor"],
      ["enrollmentId", "serviceId", "keyVersion", "capability", "scope"],
      "attestor",
    );
    expectStr(a, "enrollmentId", b.enrollmentId, "KEY_NOT_BOUND");
    expectStr(a, "serviceId", b.serviceId, "KEY_NOT_BOUND");
    expectU64(a, "keyVersion", b.keyVersion, "KEY_NOT_BOUND");
    expectStr(a, "capability", "MANIFEST_ATTEST", "SCOPE_MISMATCH");
    const sc = exact(
      a["scope"],
      ["organizationId", "tradeId", "evidencePolicyId", "evidencePolicyRevision"],
      "attestor scope",
    );
    expectStr(sc, "organizationId", b.scope.organizationId, "SCOPE_MISMATCH");
    expectStr(sc, "tradeId", b.scope.tradeId, "SCOPE_MISMATCH");
    expectStr(sc, "evidencePolicyId", b.scope.evidencePolicyId, "SCOPE_MISMATCH");
    expectU64(sc, "evidencePolicyRevision", b.scope.evidencePolicyRevision, "SCOPE_MISMATCH");
    expectStr(o, "organizationId", b.scope.organizationId, "SCOPE_MISMATCH");
    const now = this.clock.now();
    const { issuedAt, expiresAt } = checkWindow(o, now, policy.attestationLifetimeMs);
    const nonce = nonceOf(o);
    // Only the exact bound key verifies; a rotated, recovered or other enrolled key does not.
    const verified = this.authority.verifyTradeServiceSignature(
      terms,
      "manifestAttestor",
      "MANIFEST_ATTESTATION",
      payload,
      signature,
    );
    this.requireBinding(terms, "manifestAttestor");
    const rev = u64(o, "manifestRevision");
    const current = this.currentRevision(tradeId);
    const stored = this.slotsAt(tradeId, current);
    const currentDigest = manifestDigest(terms, current, stored);
    if (rev !== current || str(o, "manifestDigest") !== currentDigest)
      fail("STALE_MANIFEST", "attestation does not cover the current manifest revision", { current });
    const given = list(o, "slots") as unknown as SlotFacts[];
    if (manifestDigest(terms, rev, given) !== currentDigest)
      fail("DIGEST_MISMATCH", "attested slot facts differ from the manifest");
    if (this.evaluate(tradeId).status !== "COMPLETE")
      fail("INCOMPLETE", "manifest does not satisfy the EvidencePolicy");
    const digest = digestHexFor("MANIFEST_ATTESTATION", payload);
    const id = this.ids.next("mat");
    this.db.transaction(() => {
      this.nonces.consume(`MANIFEST_ATTESTATION:${tradeId}`, nonce, expiresAt);
      if (this.currentRevision(tradeId) !== rev) fail("STALE_MANIFEST", "manifest changed while attesting");
      this.db.run(
        `INSERT INTO manifest_attestations (id, trade_id, manifest_revision, manifest_digest, digest, payload_json, signature, key_version_id, issued_at, expires_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tradeId,
        rev,
        currentDigest,
        digest,
        JSON.stringify(typed),
        signature,
        verified.keyVersionId,
        issuedAt,
        expiresAt,
        now,
      );
      this.log(null, "MANIFEST_ATTESTED", "manifest_attestation", id, {
        tradeId,
        manifestRevision: rev,
        manifestDigest: currentDigest,
        enrollmentId: verified.enrollmentId,
        keyVersion: verified.keyVersion,
      });
    });
    return {
      id,
      tradeId,
      manifestRevision: rev,
      manifestDigest: currentDigest,
      digest,
      payload,
      typed,
      signature,
      issuedAt,
      expiresAt,
    };
  }

  attestationStatus(id: string): AttestationStatus {
    const r = this.db.get("SELECT * FROM manifest_attestations WHERE id = ?", id);
    if (!r) fail("NOT_FOUND", "attestation not found");
    const tradeId = String(r["trade_id"]);
    if (Number(r["manifest_revision"]) !== this.currentRevision(tradeId)) return "SUPERSEDED";
    if (this.bindingIssue(this.terms(tradeId), "manifestAttestor")) return "INVALIDATED";
    if (this.clock.now() >= Number(r["expires_at"])) return "EXPIRED";
    if (this.evaluate(tradeId).status !== "COMPLETE") return "STALE";
    return "CURRENT";
  }

  /** The latest attestation, only while it still covers the current complete manifest. */
  currentAttestation(tradeId: string): AttestationView | null {
    const r = this.db.get(
      "SELECT * FROM manifest_attestations WHERE trade_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
      tradeId,
    );
    if (!r || this.attestationStatus(String(r["id"])) !== "CURRENT") return null;
    return this.attestationView(r);
  }

  /**
   * Digest the escrow contract treats as its current accepted manifest: the latest recorded
   * attestation while the bound attestor key is still the revision's usable key.
   */
  currentAcceptedManifestDigest(tradeId: string): string | null {
    const r = this.db.get(
      "SELECT manifest_digest FROM manifest_attestations WHERE trade_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
      tradeId,
    );
    if (!r || this.bindingIssue(this.terms(tradeId), "manifestAttestor")) return null;
    return String(r["manifest_digest"]);
  }

  /* ================================ inspection ================================ */

  /** Independent inspector decision over the current attested manifest. */
  recordInspection(tradeId: string, payload: CanonicalValue, signature: string): InspectionView {
    const { terms, policy } = this.bound(tradeId);
    const o = exact(payload, INSPECTION_FIELDS, "inspection attestation");
    checkHeader(o, terms);
    expectStr(o, "schema", "dockside/inspection-attestation@1", "UNSUPPORTED_VERSION");
    expectStr(o, "milestoneId", terms.milestone.id, "SCOPE_MISMATCH");
    expectStr(o, "evidencePolicyId", policy.policyId, "POLICY_MISMATCH");
    expectU64(o, "evidencePolicyRevision", policy.revision, "POLICY_MISMATCH");
    expectStr(o, "inspectorPrincipalId", terms.inspector.principalId, "KEY_NOT_BOUND");
    expectStr(o, "inspectorKeyVersionId", terms.inspector.keyVersionId, "KEY_NOT_BOUND");
    const now = this.clock.now();
    const { issuedAt, expiresAt } = checkWindow(o, now, MAX_INSPECTION_LIFETIME_MS);
    const decision = str(o, "decision");
    if (decision !== "PASS" && decision !== "FAIL" && decision !== "REVIEW")
      fail("VALIDATION_FAILED", "decision must be PASS, FAIL or REVIEW");
    const reasons = list(o, "reasonCodes");
    if (reasons.length > 16 || !reasons.every((r) => typeof r === "string" && isCode(r)))
      fail("VALIDATION_FAILED", "reason codes malformed");
    const nonce = nonceOf(o);
    const rev = u64(o, "manifestRevision");
    const m = this.manifest(tradeId);
    if (rev !== m.revision || str(o, "manifestDigest") !== m.digest)
      fail("STALE_MANIFEST", "inspection binds a manifest that is not current");
    const att = this.currentAttestation(tradeId);
    if (!att || att.manifestRevision !== rev)
      fail("MANIFEST_NOT_CURRENT", "no current, complete, unexpired attested manifest");
    this.authority.verifyPrincipalSignature({
      binding: terms.inspector,
      capability: "INSPECTOR",
      purpose: "INSPECTION_ATTESTATION",
      payload,
      signature,
    });
    this.requireBinding(terms, "inspector");
    const digest = digestHexFor("INSPECTION_ATTESTATION", payload);
    const id = this.ids.next("ins");
    this.db.transaction(() => {
      this.nonces.consume(`INSPECTION_ATTESTATION:${tradeId}`, nonce, expiresAt);
      this.db.run(
        `INSERT INTO inspection_attestations (id, trade_id, attestation_id, manifest_revision, manifest_digest, decision, reason_codes_json, digest, payload_json, signature, issued_at, expires_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tradeId,
        att.id,
        rev,
        m.digest,
        decision,
        JSON.stringify(reasons),
        digest,
        JSON.stringify(toTypedJson(payload)),
        signature,
        issuedAt,
        expiresAt,
        now,
      );
      this.log(null, "INSPECTION_RECORDED", "inspection", id, {
        tradeId,
        decision,
        manifestRevision: rev,
        manifestDigest: m.digest,
      });
    });
    return this.inspectionView(
      this.db.get("SELECT * FROM inspection_attestations WHERE id = ?", id) as never,
    );
  }

  /** The inspector decision, only while bound to the current attested manifest and unexpired. */
  currentInspection(tradeId: string): InspectionView | null {
    const r = this.db.get(
      "SELECT * FROM inspection_attestations WHERE trade_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
      tradeId,
    );
    if (!r) return null;
    if (this.attestationStatus(String(r["attestation_id"])) !== "CURRENT") return null;
    if (this.clock.now() >= Number(r["expires_at"])) return null;
    if (this.bindingIssue(this.terms(tradeId), "inspector")) return null;
    return this.inspectionView(r);
  }

  inspectionPayloadDigest(payload: CanonicalValue): string {
    return digestHexFor("INSPECTION_ATTESTATION", payload);
  }

  /* ================================= internals ================================= */

  private bound(tradeId: string): Bound {
    const t = this.db.get("SELECT * FROM evidence_trades WHERE trade_id = ?", tradeId);
    if (!t) fail("NOT_FOUND", "trade is not bound to an EvidencePolicy");
    const p = this.db.get(
      "SELECT * FROM evidence_policies WHERE policy_id = ? AND revision = ?",
      String(t["policy_id"]),
      Number(t["policy_revision"]),
    );
    if (!p) fail("INTERNAL", "bound policy missing");
    const terms = tradeTermsFromJson(JSON.parse(String(t["terms_json"])));
    if (tradeRevisionDigest(terms) !== t["terms_digest"])
      fail("INTERNAL", "stored terms do not match their digest");
    return {
      terms,
      policy: parseEvidencePolicy(JSON.parse(String(p["policy_json"]))),
      policyDigest: String(p["digest"]),
    };
  }

  private slot(policy: EvidencePolicy, slotId: string): SlotPolicy {
    const s = policy.slots.find((x) => x.slotId === slotId);
    if (!s) fail("NOT_FOUND", "slot is not part of this EvidencePolicy");
    return s;
  }

  private slotFacts(slots: readonly SlotFacts[], slotId: string): SlotFacts {
    const f = slots.find((s) => s.slotId === slotId);
    if (!f) fail("INTERNAL", "slot facts missing");
    return f;
  }

  private slotsAt(tradeId: string, revision: number): SlotFacts[] {
    if (revision === 0) {
      return this.bound(tradeId).policy.slots.map((p) => ({
        slotId: p.slotId,
        slotPolicyDigest: slotPolicyDigest(p),
        itemCount: 0,
        currentnessVersion: 0,
        items: [],
      }));
    }
    const r = this.db.get(
      "SELECT slots_json FROM evidence_manifests WHERE trade_id = ? AND revision = ?",
      tradeId,
      revision,
    );
    if (!r) fail("NOT_FOUND", "manifest revision not found");
    return JSON.parse(String(r["slots_json"])) as SlotFacts[];
  }

  /** Compare-and-swap a new manifest revision; exactly one concurrent writer wins. */
  private commitRevision(
    tradeId: string,
    expected: number,
    slotId: string,
    items: readonly ItemFacts[],
    ctx: AuthContext,
    change: { kind: "ADD" | "REPLACE" | "REMOVE"; item: ItemFacts; declaredMime: string | null },
  ): { revision: number; digest: string } {
    const { terms } = this.bound(tradeId);
    const revision = expected + 1;
    try {
      return this.db.transaction(() => {
        const cur = this.currentRevision(tradeId);
        if (cur !== expected)
          fail("VERSION_CONFLICT", "manifest changed; refresh and retry", { current: cur });
        const slots = this.slotsAt(tradeId, expected).map((s) =>
          s.slotId === slotId
            ? { ...s, items: [...items], itemCount: items.length, currentnessVersion: revision }
            : s,
        );
        const digest = manifestDigest(terms, revision, slots);
        const it = change.item;
        if (change.kind !== "REMOVE") {
          this.db.run(
            `INSERT INTO evidence_items (item_id, trade_id, slot_id, version, predecessor_item_id, original_digest, byte_length, declared_mime, detected_mime, content_class, issued_at, fresh_until, uploader_principal_id, facts_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            it.itemId,
            tradeId,
            slotId,
            it.version,
            it.predecessorItemId,
            it.originalDigest,
            it.byteLength,
            change.declaredMime,
            it.detectedMime,
            it.contentClass,
            it.issuer.issuedAt,
            it.freshUntil,
            it.uploader.principalId,
            JSON.stringify(it),
            this.clock.now(),
          );
        }
        this.db.run(
          `INSERT INTO evidence_manifests (trade_id, revision, digest, slots_json, change_kind, slot_id, item_id, actor_principal_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          tradeId,
          revision,
          digest,
          JSON.stringify(slots),
          change.kind,
          slotId,
          it.itemId,
          ctx.principal.id,
          this.clock.now(),
        );
        this.log(
          ctx,
          `EVIDENCE_ITEM_${change.kind === "ADD" ? "ADDED" : change.kind === "REPLACE" ? "REPLACED" : "REMOVED"}`,
          "evidence_item",
          it.itemId,
          {
            tradeId,
            slotId,
            manifestRevision: revision,
            manifestDigest: digest,
            originalDigest: it.originalDigest,
            predecessorItemId: it.predecessorItemId,
          },
        );
        return { revision, digest };
      });
    } catch (e) {
      if (!(e instanceof DocksideError) && isUniqueViolation(e))
        fail("VERSION_CONFLICT", "another writer committed this manifest revision first");
      throw e;
    }
  }

  private uploaderFor(ctx: AuthContext, terms: TradeTerms, slot: SlotPolicy): ItemFacts["uploader"] {
    const held = slot.uploaderCapabilities.filter((c) => ctx.capabilities.includes(c));
    if (!held.length) this.deny(ctx, "FORBIDDEN", "no capability this slot allows for uploads", slot.slotId);
    let scopeMismatch = false;
    for (const cap of held) {
      const role = PARTY_OF[cap];
      if (role !== undefined) {
        const b = terms[role];
        if (b.principalId !== ctx.principal.id) continue;
        if (b.keyVersionId !== ctx.keyVersion.id)
          this.deny(
            ctx,
            "KEY_NOT_BOUND",
            "uploader key is not the version bound by this revision",
            slot.slotId,
          );
        return {
          principalId: ctx.principal.id,
          organizationId: ctx.organizationId,
          capability: cap,
          keyVersionId: ctx.keyVersion.id,
        };
      }
      if (
        ctx.organizationId === terms.buyer.organizationId ||
        ctx.organizationId === terms.supplier.organizationId
      ) {
        return {
          principalId: ctx.principal.id,
          organizationId: ctx.organizationId,
          capability: cap,
          keyVersionId: ctx.keyVersion.id,
        };
      }
      scopeMismatch = true;
    }
    if (scopeMismatch)
      this.deny(
        ctx,
        "SCOPE_MISMATCH",
        "uploader does not belong to a counterparty organization of this trade",
        slot.slotId,
      );
    return this.deny(ctx, "FORBIDDEN", "uploader is not the party this trade binds", slot.slotId);
  }

  private verifyIssuer(
    terms: TradeTerms,
    slot: SlotPolicy,
    originalDigest: string,
    proof: IssuerProof,
  ): ItemFacts["issuer"] {
    if (proof === null || typeof proof !== "object") fail("VALIDATION_FAILED", "issuer proof required");
    const cap = proof.capability;
    if (!(slot.issuerCapabilities as readonly string[]).includes(cap))
      fail("FORBIDDEN", "issuer capability not allowed for this slot");
    const role = PARTY_OF[cap];
    if (role === undefined) fail("FORBIDDEN", "issuer must be a bound trade party");
    const b = terms[role];
    const issuedAt = proof.issuedAt;
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0)
      fail("VALIDATION_FAILED", "issuedAt must be integer milliseconds");
    if (slot.issuedAtRequired && issuedAt === 0) fail("VALIDATION_FAILED", "issuedAt required");
    const now = this.clock.now();
    if (issuedAt > now + MAX_SKEW_MS) fail("NOT_YET_VALID", "issuedAt is in the future");
    if (now >= issuedAt + slot.freshnessMs) fail("STALE_ITEM", "item is past its freshness deadline");
    const payload = issuancePayload({
      tradeId: terms.tradeId,
      slotId: slot.slotId,
      originalDigest,
      issuedAt,
      issuerPrincipalId: b.principalId,
      issuerKeyVersionId: b.keyVersionId,
      issuerCapability: cap,
    });
    this.authority.verifyPrincipalSignature({
      binding: b,
      capability: cap as "BUYER_APPROVER",
      purpose: "EVIDENCE_ISSUANCE",
      payload,
      signature: proof.signature,
      ...(role === "inspector" ? {} : { organizationId: terms[role as "buyer" | "supplier"].organizationId }),
    });
    return {
      principalId: b.principalId,
      capability: cap,
      keyVersionId: b.keyVersionId,
      issuedAt,
      signature: proof.signature,
    };
  }

  private bindingIssue(terms: TradeTerms, role: string): string | null {
    const issue = this.authority.bindingStatus(terms).issues.find((i) => i.role === role);
    return issue ? issue.code : null;
  }

  /** The bound key must still be the revision's current, usable key; otherwise a new revision is required. */
  private requireBinding(terms: TradeTerms, role: string): void {
    const issue = this.bindingIssue(terms, role);
    if (issue === "KEY_REVOKED") fail("KEY_REVOKED", `the ${role} key bound by this revision is revoked`);
    if (issue !== null) fail("KEY_NOT_BOUND", `the ${role} binding requires a new trade revision (${issue})`);
  }

  private quarantineRecord(
    tradeId: string,
    slotId: string,
    reason: string,
    detail: string,
    digest: string | null,
    observed: number,
    ctx: AuthContext,
  ): void {
    const id = this.ids.next("evi");
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO evidence_quarantine (id, trade_id, slot_id, reason, detail, original_digest, observed_bytes, actor_principal_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tradeId,
        slotId,
        reason,
        detail.slice(0, 200),
        digest,
        observed,
        ctx.principal.id,
        this.clock.now(),
      );
      this.log(ctx, "EVIDENCE_QUARANTINED", "evidence_quarantine", id, {
        tradeId,
        slotId,
        reason,
        originalDigest: digest,
      });
    });
  }

  private deny(
    ctx: AuthContext,
    code: "FORBIDDEN" | "SCOPE_MISMATCH" | "KEY_NOT_BOUND",
    message: string,
    slotId: string,
  ): never {
    this.log(ctx, "EVIDENCE_UPLOAD_DENIED", "evidence_slot", slotId, { code });
    return fail(code, message);
  }

  private log(
    ctx: AuthContext | null,
    eventType: string,
    subjectType: string,
    subjectId: string,
    payload: Record<string, string | number | boolean | null>,
  ): void {
    this.audit.append({
      eventType,
      organizationId: ctx?.organizationId ?? null,
      actorPrincipalId: ctx?.principal.id ?? null,
      actorKeyVersionId: ctx?.keyVersion.id ?? null,
      sessionId: ctx?.session.id ?? null,
      subjectType,
      subjectId,
      correlationId: ctx?.correlationId ?? this.ids.next("cor"),
      source: SOURCE,
      payload,
    });
  }

  private attestationView(r: Record<string, unknown>): AttestationView {
    const typed = JSON.parse(String(r["payload_json"])) as TypedJson;
    return {
      id: String(r["id"]),
      tradeId: String(r["trade_id"]),
      manifestRevision: Number(r["manifest_revision"]),
      manifestDigest: String(r["manifest_digest"]),
      digest: String(r["digest"]),
      payload: fromTypedJson(typed),
      typed,
      signature: String(r["signature"]),
      issuedAt: Number(r["issued_at"]),
      expiresAt: Number(r["expires_at"]),
    };
  }

  private inspectionView(r: Record<string, unknown>): InspectionView {
    return {
      id: String(r["id"]),
      tradeId: String(r["trade_id"]),
      attestationId: String(r["attestation_id"]),
      manifestRevision: Number(r["manifest_revision"]),
      manifestDigest: String(r["manifest_digest"]),
      decision: String(r["decision"]) as InspectionView["decision"],
      reasonCodes: JSON.parse(String(r["reason_codes_json"])) as string[],
      digest: String(r["digest"]),
      issuedAt: Number(r["issued_at"]),
      expiresAt: Number(r["expires_at"]),
    };
  }
}

export type { Struct };
