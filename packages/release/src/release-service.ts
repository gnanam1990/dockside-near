import type { AuthContext, AuthorityService } from "@dockside/authority";
import {
  type CanonicalValue,
  type Capability,
  type Clock,
  digestHexFor,
  fail,
  fromTypedJson,
  type IdGenerator,
  newNonce,
  type SigningPurpose,
  type TradeTerms,
  type TypedJson,
  toTypedJson,
  tradeRevisionDigest,
  tradeTermsCanonical,
  tradeTermsFromJson,
  tradeTermsToJson,
} from "@dockside/core";
import type { EvidenceService, HoldService } from "@dockside/evidence";
import {
  ABANDON_POLICY,
  type AbandonTrigger,
  abandonReleaseIntentPayload,
  buyerApprovalPayload,
  cancelConsentPayload,
  cancelReleaseIntentPayload,
  destinationChangeRevokePayload,
  type EscrowContract,
  type ExitBinding,
  type FunctionCall,
  type PartySignerRole,
  type ReleaseIntentState,
  type ReleaseView,
  type ReservationSlice,
  releaseIntentPayload,
  revokeCancelConsentPayload,
  tradeBinding,
} from "@dockside/near";
import { AuditLog, type Database, isUniqueViolation } from "@dockside/store";

/**
 * Release intents, buyer approval, pre-submit exits and destination change on the service side.
 *
 * The escrow contract is the authority (contract/crates/dockside-escrow-core/src/release.rs). This
 * service never holds a party key: it prepares the exact canonical payloads, verifies the party
 * signatures against the keys the active revision binds, refuses what the contract would refuse
 * (so a compromised or buggy client cannot even get a relay), journals every observation, and
 * returns unsigned function calls for relay. A trade has at most one live journal row (partial
 * unique index), so two API processes racing to lock the same value cannot both succeed.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SOURCE = "dockside-release";
const PREPARED_LIFETIME_MS = HOUR;
const DEFAULT_INTENT_LIFETIME_MS = 3 * DAY;
const MAX_INTENT_LIFETIME_MS = 14 * DAY;
const APPROVAL_LIFETIME_MS = DAY;
const EXIT_LIFETIME_MS = 2 * HOUR;

export type JournalState = ReleaseIntentState | "PREPARED" | "EXPIRED_UNSIGNED";

export const PRE_SUBMIT_STATES: readonly ReleaseIntentState[] = [
  "VALUE_LOCKED",
  "DIRECT_TESTNET_AUTHORIZED",
  "FUNDED_AUTHORIZATION_REQUIRED",
  "FUNDED_AUTHORIZED",
];
export const UNRESOLVED_STATES: readonly ReleaseIntentState[] = [
  "SUBMITTING",
  "PROCESSING",
  "UNKNOWN",
  "REVIEW",
  "RECONCILING",
  "ADJUDICATION",
];
const LIVE: readonly JournalState[] = ["PREPARED", ...PRE_SUBMIT_STATES, ...UNRESOLVED_STATES];

export function isLive(s: JournalState): boolean {
  return LIVE.includes(s);
}

export interface ReleaseDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly authority: AuthorityService;
  readonly evidence: EvidenceService;
  readonly holds: HoldService;
  readonly escrow: EscrowContract;
}

export interface JournalIntent {
  readonly releaseIntentId: string;
  readonly tradeId: string;
  readonly tradeRevision: number;
  readonly state: JournalState;
  readonly live: boolean;
  readonly version: number;
  readonly contractVersion: number | null;
  readonly amountYocto: bigint;
  readonly slices: ReservationSlice[];
  readonly destination: string;
  readonly predecessorId: string | null;
  readonly requestDigest: string | null;
  readonly intentExpiresAt: number;
  readonly children: { childId: string; kind: "ATTEMPT" | "QUOTE"; ordinal: number }[];
}

export interface PreparedPayload {
  readonly payload: CanonicalValue;
  readonly typed: TypedJson;
  readonly digest: string;
}

type PartyRole = "BUYER_APPROVER" | "SUPPLIER_SIGNER";

function prepared(purpose: SigningPurpose, payload: CanonicalValue): PreparedPayload {
  return { payload, typed: toTypedJson(payload), digest: digestHexFor(purpose, payload) };
}

function stateError(st: string): never {
  if ((UNRESOLVED_STATES as readonly string[]).includes(st))
    fail("VALUE_LOCKED", `release intent is ${st}: the value lock admits no competing action`, { state: st });
  return fail("INVALID_STATE", `release intent is ${st}`, { state: st });
}

function str(o: CanonicalValue, k: string): string {
  const v = (o as Record<string, CanonicalValue>)[k];
  if (typeof v !== "string") fail("VALIDATION_FAILED", `field ${k} must be a string`);
  return v;
}

export class ReleaseService {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly authority: AuthorityService;
  private readonly evidence: EvidenceService;
  private readonly holds: HoldService;
  readonly escrow: EscrowContract;
  private readonly audit: AuditLog;

  constructor(deps: ReleaseDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.authority = deps.authority;
    this.evidence = deps.evidence;
    this.holds = deps.holds;
    this.escrow = deps.escrow;
    this.audit = new AuditLog(deps.db, deps.clock, deps.ids);
  }

  /* ================================ journal ================================ */

  intent(releaseIntentId: string): JournalIntent {
    const r = this.db.get("SELECT * FROM release_intents WHERE intent_id = ?", releaseIntentId);
    if (!r) fail("NOT_FOUND", "release intent not found");
    const children = this.db
      .all(
        "SELECT child_id, kind, ordinal FROM release_children WHERE intent_id = ? ORDER BY ordinal",
        releaseIntentId,
      )
      .map((c) => ({
        childId: String(c["child_id"]),
        kind: String(c["kind"]) as "ATTEMPT" | "QUOTE",
        ordinal: Number(c["ordinal"]),
      }));
    const slices = (JSON.parse(String(r["slices_json"])) as { funder: string; amountYocto: string }[]).map(
      (s) => ({
        funder: s.funder,
        amountYocto: BigInt(s.amountYocto),
      }),
    );
    return {
      releaseIntentId: String(r["intent_id"]),
      tradeId: String(r["trade_id"]),
      tradeRevision: Number(r["trade_revision"]),
      state: String(r["state"]) as JournalState,
      live: Number(r["live"]) === 1,
      version: Number(r["version"]),
      contractVersion: r["contract_version"] === null ? null : Number(r["contract_version"]),
      amountYocto: BigInt(String(r["amount_yocto"])),
      slices,
      destination: String(r["destination"]),
      predecessorId: r["predecessor_id"] === null ? null : String(r["predecessor_id"]),
      requestDigest: r["request_digest"] === null ? null : String(r["request_digest"]),
      intentExpiresAt: Number(r["intent_expires_at"]),
      children,
    };
  }

  liveIntent(tradeId: string): JournalIntent | null {
    const r = this.db.get("SELECT intent_id FROM release_intents WHERE trade_id = ? AND live = 1", tradeId);
    return r ? this.intent(String(r["intent_id"])) : null;
  }

  /** Refuse any competing action while the journal shows a submitted, unresolved intent (INV-09). */
  assertNoUnresolvedRelease(tradeId: string): void {
    const l = this.liveIntent(tradeId);
    if (l && (UNRESOLVED_STATES as readonly string[]).includes(l.state)) stateError(l.state);
    this.assertEconomicJournal(tradeId, null, { frozen: false });
  }

  /**
   * M05 economic-operation journal (0005_journal.sql). A trade frozen by a reconciliation
   * incident admits no new intent, approval, submit or activation; an operation that holds the
   * value lock admits no competing action; and an intent that already has an operation (queued,
   * unresolved or authoritatively FAILED) can never be approved or submitted again: retry needs a
   * new intent and fresh approval.
   */
  private assertEconomicJournal(tradeId: string, intentId: string | null, opts: { frozen: boolean }): void {
    if (opts.frozen) {
      const f = this.db.get("SELECT cause_id FROM trade_freezes WHERE trade_id = ? LIMIT 1", tradeId);
      if (f)
        fail("TRADE_FROZEN", "trade is frozen by a reconciliation incident", {
          cause: String(f["cause_id"]),
        });
    }
    const lock = this.db.get(
      "SELECT state, kind FROM economic_operations WHERE trade_id = ? AND lock_held = 1 LIMIT 1",
      tradeId,
    );
    if (lock)
      fail(
        "VALUE_LOCKED",
        `an economic ${String(lock["kind"]).toLowerCase()} operation (${String(lock["state"])}) owns the value lock`,
        {
          state: String(lock["state"]),
        },
      );
    if (intentId) {
      const op = this.db.get(
        "SELECT state FROM economic_operations WHERE kind = 'RELEASE' AND subject_id = ? AND state <> 'WITHDRAWN'",
        intentId,
      );
      if (op)
        fail(
          "INVALID_STATE",
          `release intent already has an economic operation (${String(op["state"])}); a retry needs a new intent`,
          {
            state: String(op["state"]),
          },
        );
    }
  }

  private event(
    intentId: string,
    from: JournalState | null,
    to: JournalState,
    version: number,
    source: "SERVICE" | "CONTRACT_OBSERVATION",
    detail: Record<string, string | number | boolean | null>,
  ): void {
    this.db.run(
      `INSERT INTO release_intent_events (id, intent_id, from_state, to_state, version, source, detail_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.ids.next("rle"),
      intentId,
      from,
      to,
      version,
      source,
      JSON.stringify(detail),
      this.clock.now(),
    );
  }

  /**
   * Mirror the contract's release state into the journal: new intents (e.g. the successor created
   * by destination activation), state changes and attempt children. Transitions are recorded as
   * contract observations; a contradiction with a terminal journal state fails closed.
   */
  async sync(tradeId: string): Promise<ReleaseView> {
    const view = await this.escrow.getRelease(tradeId);
    this.db.transaction(() => {
      // Non-live first so a successor can take the one live slot its predecessor released.
      const ordered = [...view.intents].sort((a, b) => Number(isLive(a.state)) - Number(isLive(b.state)));
      for (const c of ordered) {
        const live = isLive(c.state) ? 1 : 0;
        const slices = JSON.stringify(
          c.slices.map((s) => ({ funder: s.funder, amountYocto: String(s.amount) })),
        );
        const row = this.db.get("SELECT * FROM release_intents WHERE intent_id = ?", c.releaseIntentId);
        if (!row) {
          // A competing PREPARED row that never reached the chain cannot hold the slot.
          if (live) this.expireUnsigned(tradeId, true);
          this.db.run(
            `INSERT INTO release_intents (intent_id, trade_id, trade_revision, idempotency_key, request_digest, request_json,
               buyer_signature, amount_yocto, slices_json, destination, profile, state, live, version, contract_version,
               predecessor_id, prepared_by, intent_expires_at, prepared_expires_at, created_at, updated_at)
             VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, 'DIRECT_TESTNET', ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?)`,
            c.releaseIntentId,
            tradeId,
            c.tradeRevision,
            String(c.amount),
            slices,
            c.destination,
            c.state,
            live,
            c.stateVersion,
            c.predecessor,
            c.expiresAt,
            c.expiresAt,
            this.clock.now(),
            this.clock.now(),
          );
          this.event(c.releaseIntentId, null, c.state, 1, "CONTRACT_OBSERVATION", {
            contractVersion: c.stateVersion,
            predecessor: c.predecessor,
          });
        } else {
          const from = String(row["state"]) as JournalState;
          if (row["slices_json"] !== slices || String(row["amount_yocto"]) !== String(c.amount))
            fail("INTERNAL", "contract reservation differs from the journaled intent");
          if (from !== c.state || Number(row["contract_version"]) !== c.stateVersion) {
            if (!isLive(from) && from !== "PREPARED" && from !== c.state)
              fail("INTERNAL", "contract state contradicts a terminal journal state", { from, to: c.state });
            const version = Number(row["version"]) + 1;
            this.db.run(
              "UPDATE release_intents SET state = ?, live = ?, version = ?, contract_version = ?, updated_at = ? WHERE intent_id = ? AND version = ?",
              c.state,
              live,
              version,
              c.stateVersion,
              this.clock.now(),
              c.releaseIntentId,
              Number(row["version"]),
            );
            this.event(c.releaseIntentId, from, c.state, version, "CONTRACT_OBSERVATION", {
              contractVersion: c.stateVersion,
            });
          }
        }
        c.attempts.forEach((a, i) => {
          this.db.run(
            "INSERT OR IGNORE INTO release_children (child_id, intent_id, kind, ordinal, recorded_at) VALUES (?, ?, 'ATTEMPT', ?, ?)",
            a,
            c.releaseIntentId,
            i + 1,
            this.clock.now(),
          );
        });
      }
    });
    return view;
  }

  private expireUnsigned(tradeId: string, force: boolean): void {
    const r = this.db.get(
      "SELECT intent_id, version, prepared_expires_at FROM release_intents WHERE trade_id = ? AND live = 1 AND state = 'PREPARED'",
      tradeId,
    );
    if (!r) return;
    if (!force && this.clock.now() < Number(r["prepared_expires_at"])) return;
    const version = Number(r["version"]) + 1;
    this.db.run(
      "UPDATE release_intents SET state = 'EXPIRED_UNSIGNED', live = 0, version = ?, updated_at = ? WHERE intent_id = ?",
      version,
      this.clock.now(),
      String(r["intent_id"]),
    );
    this.event(String(r["intent_id"]), "PREPARED", "EXPIRED_UNSIGNED", version, "SERVICE", {});
  }

  /* ============================ party authorization ============================ */

  private requireParty(ctx: AuthContext, terms: TradeTerms, role: PartyRole): void {
    const b = role === "BUYER_APPROVER" ? terms.buyer : terms.supplier;
    if (!ctx.capabilities.includes(role as Capability))
      this.deny(ctx, terms.tradeId, "FORBIDDEN", `${role} required`);
    if (ctx.principal.id !== b.principalId)
      this.deny(ctx, terms.tradeId, "FORBIDDEN", "session principal is not the party this revision binds");
    if (ctx.keyVersion.id !== b.keyVersionId)
      this.deny(
        ctx,
        terms.tradeId,
        "KEY_NOT_BOUND",
        "session key is not the key version this revision binds",
      );
  }

  private partyRole(ctx: AuthContext, terms: TradeTerms): PartyRole {
    if (ctx.principal.id === terms.buyer.principalId) {
      this.requireParty(ctx, terms, "BUYER_APPROVER");
      return "BUYER_APPROVER";
    }
    if (ctx.principal.id === terms.supplier.principalId) {
      this.requireParty(ctx, terms, "SUPPLIER_SIGNER");
      return "SUPPLIER_SIGNER";
    }
    return this.deny(
      ctx,
      terms.tradeId,
      "FORBIDDEN",
      "only the designated buyer approver or supplier signer",
    );
  }

  private verifyParty(
    terms: TradeTerms,
    role: PartyRole,
    purpose: SigningPurpose,
    payload: CanonicalValue,
    sig: string,
  ) {
    const b = role === "BUYER_APPROVER" ? terms.buyer : terms.supplier;
    return this.authority.verifyPrincipalSignature({
      binding: b,
      capability: role,
      purpose,
      payload,
      signature: sig,
      organizationId: b.organizationId,
    });
  }

  private recordSignature(
    tradeId: string,
    intentId: string | null,
    kind: string,
    role: string,
    verified: { principalId: string; keyVersionId: string },
    purpose: SigningPurpose,
    payload: CanonicalValue,
    signature: string,
    expiresAt: number,
  ): string {
    const digest = digestHexFor(purpose, payload);
    try {
      this.db.run(
        `INSERT INTO release_signatures (id, trade_id, intent_id, kind, signer_role, signer_principal, key_version_id, digest, payload_json, signature, expires_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.ids.next("rsg"),
        tradeId,
        intentId,
        kind,
        role,
        verified.principalId,
        verified.keyVersionId,
        digest,
        JSON.stringify(toTypedJson(payload)),
        signature,
        expiresAt,
        this.clock.now(),
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const prior = this.db.get(
        "SELECT signature FROM release_signatures WHERE digest = ? AND signer_role = ?",
        digest,
        role,
      );
      if (prior?.["signature"] !== signature) fail("NONCE_REPLAYED", "this payload was already recorded");
    }
    this.log(null, `RELEASE_${kind}_VERIFIED`, intentId ? "release_intent" : "trade", intentId ?? tradeId, {
      digest,
      role,
    });
    return digest;
  }

  /* ============================== release intent ============================== */

  /**
   * Prepare a buyer-signable release intent with a fresh random id. Exact repeats of the same
   * idempotency key join the existing intent; a different request under the key fails closed.
   */
  async prepareIntent(
    ctx: AuthContext,
    input: { tradeId: string; idempotencyKey: string; intentLifetimeMs?: number },
  ): Promise<PreparedPayload & { releaseIntentId: string; joined: boolean }> {
    const terms = this.evidence.terms(input.tradeId);
    this.requireParty(ctx, terms, "BUYER_APPROVER");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))
      fail("VALIDATION_FAILED", "idempotency key malformed");
    const lifetime = input.intentLifetimeMs ?? DEFAULT_INTENT_LIFETIME_MS;
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > MAX_INTENT_LIFETIME_MS)
      fail("VALIDATION_FAILED", "intent lifetime out of range");
    const prior = this.db.get(
      "SELECT * FROM release_intents WHERE trade_id = ? AND idempotency_key = ?",
      input.tradeId,
      input.idempotencyKey,
    );
    if (prior) {
      const sameRequest =
        Number(prior["trade_revision"]) === terms.revision &&
        Number(prior["intent_expires_at"]) - Number(prior["created_at"]) === lifetime &&
        prior["prepared_by"] === ctx.principal.id;
      if (!sameRequest) fail("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different request");
      const payload = fromTypedJson(JSON.parse(String(prior["request_json"])) as TypedJson);
      return {
        ...prepared("RELEASE_INTENT", payload),
        releaseIntentId: String(prior["intent_id"]),
        joined: true,
      };
    }
    this.assertEconomicJournal(input.tradeId, null, { frozen: true });
    const view = await this.sync(input.tradeId);
    const ledger = await this.escrow.getLedger(input.tradeId);
    this.expireUnsigned(input.tradeId, false);
    const live = this.liveIntent(input.tradeId);
    if (live) {
      if (live.state === "PREPARED")
        fail("VALUE_LOCKED", "another release intent is awaiting its buyer signature");
      fail("VALUE_LOCKED", `release intent ${live.releaseIntentId} (${live.state}) owns the value lock`);
    }
    if (view.liveIntent) fail("VALUE_LOCKED", "the contract shows a live release intent");
    if (view.intents.some((i) => i.state === "PAID"))
      fail("INVALID_STATE", "the trade value has already been released");
    if (view.revision !== terms.revision || view.termsDigest !== tradeRevisionDigest(terms))
      fail("STALE_REVISION", "the contract's active revision differs from the bound terms");
    if (!ledger.fullyFunded) fail("NOT_FULLY_FUNDED", "the trade is not fully funded");
    const slices: ReservationSlice[] = Object.entries(ledger.funders)
      .filter(([, f]) => f.available > 0n)
      .map(([funder, f]) => ({ funder, amountYocto: f.available }))
      .sort((a, b) => (a.funder < b.funder ? -1 : 1));
    const total = slices.reduce((a, s) => a + s.amountYocto, 0n);
    if (total !== terms.amountYocto) fail("STALE_LEDGER", "available value differs from the trade amount");
    const now = this.clock.now();
    if (now + lifetime > terms.expiresAt) fail("VALIDATION_FAILED", "intent cannot outlive the trade");
    const releaseIntentId = this.ids.next("rli");
    const payload = releaseIntentPayload(tradeBinding(terms), {
      network: terms.network,
      releaseIntentId,
      amountYocto: terms.amountYocto,
      destination: terms.payout.destination,
      slices,
      intentExpiresAt: now + lifetime,
      issuedAt: now,
      expiresAt: now + PREPARED_LIFETIME_MS,
      nonce: newNonce(),
    });
    const p = prepared("RELEASE_INTENT", payload);
    try {
      this.db.transaction(() => {
        this.db.run(
          `INSERT INTO release_intents (intent_id, trade_id, trade_revision, idempotency_key, request_digest, request_json,
             buyer_signature, amount_yocto, slices_json, destination, profile, state, live, version, contract_version,
             predecessor_id, prepared_by, intent_expires_at, prepared_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'DIRECT_TESTNET', 'PREPARED', 1, 1, NULL, NULL, ?, ?, ?, ?, ?)`,
          releaseIntentId,
          input.tradeId,
          terms.revision,
          input.idempotencyKey,
          p.digest,
          JSON.stringify(p.typed),
          String(terms.amountYocto),
          JSON.stringify(slices.map((s) => ({ funder: s.funder, amountYocto: String(s.amountYocto) }))),
          terms.payout.destination,
          ctx.principal.id,
          now + lifetime,
          now + PREPARED_LIFETIME_MS,
          now,
          now,
        );
        this.event(releaseIntentId, null, "PREPARED", 1, "SERVICE", { requestDigest: p.digest });
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("VALUE_LOCKED", "a concurrent request took the value lock first");
      throw e;
    }
    this.log(ctx, "RELEASE_INTENT_PREPARED", "release_intent", releaseIntentId, { requestDigest: p.digest });
    return { ...p, releaseIntentId, joined: false };
  }

  /** Verify the buyer's signature over the prepared intent and return the relay call. */
  recordIntentSignature(
    ctx: AuthContext,
    input: { releaseIntentId: string; signature: string },
  ): FunctionCall {
    const j = this.intent(input.releaseIntentId);
    const terms = this.evidence.terms(j.tradeId);
    this.requireParty(ctx, terms, "BUYER_APPROVER");
    const r = this.db.get("SELECT * FROM release_intents WHERE intent_id = ?", input.releaseIntentId);
    if (!r || r["request_json"] === null) fail("NOT_FOUND", "no prepared request for this intent");
    const payload = fromTypedJson(JSON.parse(String(r["request_json"])) as TypedJson);
    if (r["buyer_signature"] !== null) {
      if (r["buyer_signature"] !== input.signature)
        fail("IDEMPOTENCY_CONFLICT", "intent already carries a signature");
    } else {
      if (j.state !== "PREPARED") stateError(j.state);
      if (this.clock.now() >= Number(r["prepared_expires_at"]))
        fail("EXPIRED", "prepared intent expired; prepare again");
      this.verifyParty(terms, "BUYER_APPROVER", "RELEASE_INTENT", payload, input.signature);
      this.db.run(
        "UPDATE release_intents SET buyer_signature = ?, updated_at = ? WHERE intent_id = ?",
        input.signature,
        this.clock.now(),
        input.releaseIntentId,
      );
      this.log(ctx, "RELEASE_INTENT_SIGNED", "release_intent", input.releaseIntentId, {});
    }
    return this.escrow.createReleaseIntentCall(j.tradeId, toTypedJson(payload), input.signature);
  }

  /* =============================== readiness ================================ */

  /**
   * Every missing term of the release conjunction, from the contract's own recomputation plus the
   * service's evidence and hold journals (which must agree with it). Empty means releasable now.
   */
  async readiness(tradeId: string): Promise<string[]> {
    const view = await this.sync(tradeId);
    const ev = await this.escrow.getEvidence(tradeId);
    const out = new Set(view.blockers);
    const att = this.evidence.currentAttestation(tradeId);
    if (!att) out.add("MANIFEST_NOT_CURRENT");
    else if (ev.current?.digest !== att.manifestDigest) out.add("STALE_MANIFEST");
    const ins = this.evidence.currentInspection(tradeId);
    if (ins?.decision !== "PASS") out.add("INSPECTION_NOT_PASS");
    else if (ev.inspection?.digest !== ins.digest) out.add("STALE_MANIFEST");
    if (this.holds.blocking(tradeId) > 0) out.add("HOLD_ACTIVE");
    return [...out];
  }

  /* ============================== buyer approval ============================== */

  async prepareApproval(ctx: AuthContext, input: { releaseIntentId: string }): Promise<PreparedPayload> {
    const j = this.intent(input.releaseIntentId);
    const terms = this.evidence.terms(j.tradeId);
    this.requireParty(ctx, terms, "BUYER_APPROVER");
    this.assertEconomicJournal(j.tradeId, input.releaseIntentId, { frozen: true });
    const missing = (await this.readiness(j.tradeId)).filter((m) => m !== "APPROVAL_MISSING");
    const cur = this.intent(input.releaseIntentId);
    if (cur.state !== "VALUE_LOCKED") stateError(cur.state);
    if (missing.length) fail(missing[0] as never, `release prerequisites missing: ${missing.join(",")}`);
    const view = await this.escrow.getRelease(j.tradeId);
    const ev = await this.escrow.getEvidence(j.tradeId);
    const c = view.intents.find((i) => i.releaseIntentId === input.releaseIntentId);
    if (!c || !ev.current || !ev.inspection || !view.holdsViewDigest)
      fail("INTERNAL", "contract view incomplete");
    const now = this.clock.now();
    return prepared(
      "BUYER_APPROVAL",
      buyerApprovalPayload(tradeBinding(terms), {
        network: terms.network,
        releaseIntentId: input.releaseIntentId,
        intentStateVersion: c.stateVersion,
        amountYocto: c.amount,
        destination: c.destination,
        manifestRevision: ev.current.revision,
        manifestDigest: ev.current.digest,
        attestationDigest: ev.current.attestationDigest,
        inspectionDigest: ev.inspection.digest,
        holdsViewDigest: view.holdsViewDigest,
        issuedAt: now,
        expiresAt: Math.min(now + APPROVAL_LIFETIME_MS, c.expiresAt),
        nonce: newNonce(),
      }),
    );
  }

  recordApproval(ctx: AuthContext, input: { payload: CanonicalValue; signature: string }): FunctionCall {
    const id = str(input.payload, "releaseIntentId");
    const j = this.intent(id);
    const terms = this.evidence.terms(j.tradeId);
    this.requireParty(ctx, terms, "BUYER_APPROVER");
    if (j.state !== "VALUE_LOCKED") stateError(j.state);
    this.assertEconomicJournal(j.tradeId, id, { frozen: true });
    const v = this.verifyParty(terms, "BUYER_APPROVER", "BUYER_APPROVAL", input.payload, input.signature);
    const exp = Number((input.payload as Record<string, CanonicalValue>)["expiresAt"]);
    this.recordSignature(
      j.tradeId,
      id,
      "BUYER_APPROVAL",
      "BUYER_APPROVER",
      v,
      "BUYER_APPROVAL",
      input.payload,
      input.signature,
      exp,
    );
    return this.escrow.approveReleaseCall(j.tradeId, toTypedJson(input.payload), input.signature);
  }

  /** Relay for the direct release; refused unless the full conjunction holds on both sides. */
  async prepareExecution(releaseIntentId: string): Promise<FunctionCall> {
    const j = this.intent(releaseIntentId);
    this.assertEconomicJournal(j.tradeId, releaseIntentId, { frozen: true });
    const missing = await this.readiness(j.tradeId);
    const cur = this.intent(releaseIntentId);
    if (!(PRE_SUBMIT_STATES as readonly string[]).includes(cur.state)) stateError(cur.state);
    if (missing.length) fail(missing[0] as never, `release prerequisites missing: ${missing.join(",")}`);
    this.log(null, "RELEASE_EXECUTION_RELAYED", "release_intent", releaseIntentId, {});
    return this.escrow.executeReleaseCall(j.tradeId, releaseIntentId);
  }

  /* ================================== exits ================================== */

  private async exitBinding(
    releaseIntentId: string,
  ): Promise<{ terms: TradeTerms; x: ExitBinding; view: ReleaseView }> {
    const j = this.intent(releaseIntentId);
    const terms = this.evidence.terms(j.tradeId);
    this.assertEconomicJournal(j.tradeId, null, { frozen: false });
    const view = await this.sync(j.tradeId);
    const c = view.intents.find((i) => i.releaseIntentId === releaseIntentId);
    if (!c) fail("NOT_FOUND", "release intent not on the contract");
    if (view.liveIntent !== releaseIntentId || !(PRE_SUBMIT_STATES as readonly string[]).includes(c.state))
      stateError(c.state);
    return {
      terms,
      view,
      x: {
        network: terms.network,
        organizationId: terms.buyer.organizationId,
        releaseIntentId,
        expectedState: c.state,
        stateVersion: c.stateVersion,
        amountYocto: c.amount,
        destination: c.destination,
        slices: c.slices.map((s) => ({ funder: s.funder, amountYocto: s.amount })),
      },
    };
  }

  /** The canonical CANCEL payload both parties must consent to. It is not signed by itself. */
  async prepareCancel(
    ctx: AuthContext,
    input: { releaseIntentId: string; reasonCode: string },
  ): Promise<PreparedPayload> {
    const { terms, x } = await this.exitBinding(input.releaseIntentId);
    this.partyRole(ctx, terms);
    if (!/^[A-Z0-9_]{1,64}$/.test(input.reasonCode)) fail("VALIDATION_FAILED", "reasonCode malformed");
    const now = this.clock.now();
    return prepared(
      "CANCEL_RELEASE_INTENT",
      cancelReleaseIntentPayload(tradeBinding(terms), {
        ...x,
        reasonCode: input.reasonCode,
        issuedAt: now,
        expiresAt: now + EXIT_LIFETIME_MS,
        nonce: newNonce(),
      }),
    );
  }

  /** The calling party's own consent over an exact CANCEL payload. */
  async prepareCancelConsent(ctx: AuthContext, cancel: CanonicalValue): Promise<PreparedPayload> {
    const id = str(cancel, "releaseIntentId");
    const { terms } = await this.exitBinding(id);
    const role = this.partyRole(ctx, terms);
    const now = this.clock.now();
    const cancelExpires = Number((cancel as Record<string, CanonicalValue>)["expiresAt"]);
    if (!(now < cancelExpires)) fail("EXPIRED", "cancel payload expired");
    const b = role === "BUYER_APPROVER" ? terms.buyer : terms.supplier;
    return prepared(
      "CANCEL_CONSENT",
      cancelConsentPayload(tradeBinding(terms), {
        cancelDigest: digestHexFor("CANCEL_RELEASE_INTENT", cancel),
        signerRole: role,
        keyVersionId: b.keyVersionId,
        issuedAt: now,
        expiresAt: Math.min(now + HOUR, cancelExpires),
        nonce: newNonce(),
      }),
    );
  }

  async recordCancelConsent(
    ctx: AuthContext,
    input: { cancel: CanonicalValue; consent: CanonicalValue; signature: string },
  ): Promise<FunctionCall> {
    const id = str(input.cancel, "releaseIntentId");
    const { terms, view } = await this.exitBinding(id);
    const role = this.partyRole(ctx, terms);
    if (str(input.consent, "signerRole") !== role) fail("FORBIDDEN", "a party consents only for itself");
    const cancelDigest = digestHexFor("CANCEL_RELEASE_INTENT", input.cancel);
    if (str(input.consent, "cancelDigest") !== cancelDigest)
      fail("CANCEL_DISAGREEMENT", "consent names another payload");
    const pending = view.intents.find((i) => i.releaseIntentId === id)?.pendingCancel;
    const open = pending?.consents.some((c) => !c.revoked && this.clock.now() < c.expiresAt);
    if (pending && pending.digest !== cancelDigest && open && this.clock.now() < pending.expiresAt)
      fail("CANCEL_DISAGREEMENT", "a different cancel payload is pending");
    const v = this.verifyParty(terms, role, "CANCEL_CONSENT", input.consent, input.signature);
    const exp = Number((input.consent as Record<string, CanonicalValue>)["expiresAt"]);
    this.recordSignature(
      terms.tradeId,
      id,
      "CANCEL_CONSENT",
      role,
      v,
      "CANCEL_CONSENT",
      input.consent,
      input.signature,
      exp,
    );
    return this.escrow.submitCancelConsentCall(
      terms.tradeId,
      toTypedJson(input.cancel),
      toTypedJson(input.consent),
      input.signature,
    );
  }

  /** The calling party withdraws its own pending consent. */
  async prepareConsentRevocation(
    ctx: AuthContext,
    input: { releaseIntentId: string; consent: CanonicalValue },
  ): Promise<PreparedPayload> {
    const { terms } = await this.exitBinding(input.releaseIntentId);
    const role = this.partyRole(ctx, terms);
    if (str(input.consent, "signerRole") !== role) fail("FORBIDDEN", "a party revokes only its own consent");
    const now = this.clock.now();
    return prepared(
      "REVOKE_CANCEL_CONSENT",
      revokeCancelConsentPayload(tradeBinding(terms), {
        releaseIntentId: input.releaseIntentId,
        cancelDigest: str(input.consent, "cancelDigest"),
        signerRole: role as PartySignerRole,
        consentNonce: str(input.consent, "nonce"),
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      }),
    );
  }

  async recordConsentRevocation(
    ctx: AuthContext,
    input: { payload: CanonicalValue; signature: string },
  ): Promise<FunctionCall> {
    const id = str(input.payload, "releaseIntentId");
    const { terms } = await this.exitBinding(id);
    const role = this.partyRole(ctx, terms);
    if (str(input.payload, "signerRole") !== role) fail("FORBIDDEN", "a party revokes only its own consent");
    const v = this.verifyParty(terms, role, "REVOKE_CANCEL_CONSENT", input.payload, input.signature);
    const exp = Number((input.payload as Record<string, CanonicalValue>)["expiresAt"]);
    this.recordSignature(
      terms.tradeId,
      id,
      "CANCEL_CONSENT_REVOKE",
      role,
      v,
      "REVOKE_CANCEL_CONSENT",
      input.payload,
      input.signature,
      exp,
    );
    return this.escrow.revokeCancelConsentCall(terms.tradeId, toTypedJson(input.payload), input.signature);
  }

  /** ABANDON after the objective trigger and the profile's grace, recomputed from contract state. */
  async prepareAbandon(
    ctx: AuthContext,
    input: { releaseIntentId: string; trigger: AbandonTrigger },
  ): Promise<PreparedPayload> {
    const { terms, x, view } = await this.exitBinding(input.releaseIntentId);
    const role = this.partyRole(ctx, terms);
    const c = view.intents.find((i) => i.releaseIntentId === input.releaseIntentId);
    let triggerAt: number;
    if (input.trigger === "INTENT_EXPIRED") triggerAt = c?.expiresAt ?? 0;
    else if (input.trigger === "BUYER_APPROVAL_EXPIRED") {
      if (c?.state !== "DIRECT_TESTNET_AUTHORIZED" || !c.approval)
        fail("NOT_ELIGIBLE", "the intent carries no buyer approval to expire");
      triggerAt = c.approval.expiresAt;
    } else return fail("NOT_ELIGIBLE", "no funded authorization exists in the direct testnet profile");
    const now = this.clock.now();
    if (now < triggerAt + ABANDON_POLICY.graceMs)
      fail("DELAY_NOT_ELAPSED", "the objective trigger and grace period have not elapsed", {
        abandonAfter: triggerAt + ABANDON_POLICY.graceMs,
      });
    const b = role === "BUYER_APPROVER" ? terms.buyer : terms.supplier;
    return prepared(
      "ABANDON_RELEASE_INTENT",
      abandonReleaseIntentPayload(tradeBinding(terms), {
        ...x,
        trigger: input.trigger,
        triggerAt,
        signerRole: role,
        keyVersionId: b.keyVersionId,
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      }),
    );
  }

  async recordAbandon(
    ctx: AuthContext,
    input: { payload: CanonicalValue; signature: string },
  ): Promise<FunctionCall> {
    const id = str(input.payload, "releaseIntentId");
    const { terms } = await this.exitBinding(id);
    const role = this.partyRole(ctx, terms);
    if (str(input.payload, "signerRole") !== role) fail("FORBIDDEN", "a party abandons only in its own role");
    const v = this.verifyParty(terms, role, "ABANDON_RELEASE_INTENT", input.payload, input.signature);
    const exp = Number((input.payload as Record<string, CanonicalValue>)["expiresAt"]);
    this.recordSignature(
      terms.tradeId,
      id,
      "ABANDON",
      role,
      v,
      "ABANDON_RELEASE_INTENT",
      input.payload,
      input.signature,
      exp,
    );
    return this.escrow.abandonReleaseIntentCall(terms.tradeId, toTypedJson(input.payload), input.signature);
  }

  /* ============================ destination change ============================ */

  /** Successor revision that changes only the payout destination, for both parties to sign. */
  successorTerms(
    tradeId: string,
    destination: string,
  ): { terms: TradeTerms; canonical: CanonicalValue; digest: string } {
    const cur = this.evidence.terms(tradeId);
    const json = tradeTermsToJson(cur) as Record<string, unknown>;
    const next = tradeTermsFromJson({
      ...json,
      revision: cur.revision + 1,
      predecessorDigest: tradeRevisionDigest(cur),
      payout: { ...(json["payout"] as Record<string, unknown>), destination },
    });
    if (next.payout.destination === cur.payout.destination)
      fail("VALIDATION_FAILED", "successor destination equals the active destination");
    return { terms: next, canonical: tradeTermsCanonical(next), digest: tradeRevisionDigest(next) };
  }

  /**
   * Verify a party's signature over the successor digest and return the propose call (first
   * consent) or the consent call (second consent over the identical pending digest).
   */
  async recordDestinationConsent(
    ctx: AuthContext,
    input: { tradeId: string; destination: string; signature: string },
  ): Promise<FunctionCall> {
    const cur = this.evidence.terms(input.tradeId);
    const role = this.partyRole(ctx, cur);
    this.assertEconomicJournal(input.tradeId, null, { frozen: true });
    const { terms, canonical, digest } = this.successorTerms(input.tradeId, input.destination);
    const view = await this.sync(input.tradeId);
    if (view.intents.some((i) => i.state === "PAID"))
      fail("INVALID_STATE", "the trade value has already been released");
    const pending = view.pendingDestinationChange;
    const active = pending && (pending.status === "PROPOSED" || pending.status === "CONSENTED");
    if (active && pending.successorDigest !== digest)
      fail("DESTINATION_CHANGE_PENDING", "another destination change is pending; it must be revoked first");
    const v = this.verifyParty(cur, role, "TRADE_REVISION", canonical, input.signature);
    this.recordSignature(
      input.tradeId,
      null,
      "DESTINATION_CONSENT",
      role,
      v,
      "TRADE_REVISION",
      canonical,
      input.signature,
      cur.expiresAt,
    );
    const partyRole = role === "BUYER_APPROVER" ? "BUYER" : "SUPPLIER";
    if (active) {
      return this.escrow.consentDestinationChangeCall(input.tradeId, digest, partyRole, input.signature);
    }
    return this.escrow.proposeDestinationChangeCall(
      input.tradeId,
      toTypedJson(tradeTermsCanonical(terms)),
      partyRole,
      input.signature,
    );
  }

  async prepareDestinationRevocation(ctx: AuthContext, tradeId: string): Promise<PreparedPayload> {
    const terms = this.evidence.terms(tradeId);
    const role = this.partyRole(ctx, terms);
    const view = await this.sync(tradeId);
    const p = view.pendingDestinationChange;
    if (!p) fail("NOT_FOUND", "no pending destination change");
    const now = this.clock.now();
    return prepared(
      "DESTINATION_CHANGE_REVOKE",
      destinationChangeRevokePayload(tradeBinding(terms), {
        successorDigest: p.successorDigest,
        signerRole: role === "BUYER_APPROVER" ? "BUYER" : "SUPPLIER",
        issuedAt: now,
        expiresAt: now + HOUR,
        nonce: newNonce(),
      }),
    );
  }

  recordDestinationRevocation(
    ctx: AuthContext,
    input: { payload: CanonicalValue; signature: string },
  ): FunctionCall {
    const terms = this.evidence.terms(str(input.payload, "tradeId"));
    const role = this.partyRole(ctx, terms);
    if (str(input.payload, "signerRole") !== (role === "BUYER_APPROVER" ? "BUYER" : "SUPPLIER"))
      fail("FORBIDDEN", "a party revokes only in its own role");
    const v = this.verifyParty(terms, role, "DESTINATION_CHANGE_REVOKE", input.payload, input.signature);
    const exp = Number((input.payload as Record<string, CanonicalValue>)["expiresAt"]);
    this.recordSignature(
      terms.tradeId,
      null,
      "DESTINATION_REVOKE",
      role,
      v,
      "DESTINATION_CHANGE_REVOKE",
      input.payload,
      input.signature,
      exp,
    );
    return this.escrow.revokeDestinationChangeCall(
      terms.tradeId,
      toTypedJson(input.payload),
      input.signature,
    );
  }

  /** Permissionless activation relay, refused unless the contract predicate would hold. */
  async prepareActivation(tradeId: string): Promise<FunctionCall> {
    const view = await this.sync(tradeId);
    this.assertNoUnresolvedRelease(tradeId);
    this.assertEconomicJournal(tradeId, null, { frozen: true });
    const p = view.pendingDestinationChange;
    if (!p) fail("NOT_FOUND", "no pending destination change");
    if (p.status !== "CONSENTED") fail("INVALID_STATE", "both buyer and supplier consents are required");
    if (p.delayUntil === null || this.clock.now() < p.delayUntil)
      fail("DELAY_NOT_ELAPSED", "the destination-change delay has not elapsed", { delayUntil: p.delayUntil });
    if (view.intents.some((i) => i.state === "PAID"))
      fail("INVALID_STATE", "the trade value has already been released");
    const refunds = await this.escrow.getRefunds(tradeId);
    if (refunds.some((r) => !["REFUNDED", "FAILED", "REVOKED"].includes(r.state)))
      fail("VALUE_LOCKED", "a live refund intent blocks destination activation");
    return this.escrow.activateDestinationChangeCall(tradeId, p.successorDigest);
  }

  /**
   * After the contract activated the successor revision, bind it for evidence and holds. The
   * successor and both party signatures come from the journal; the contract digest must match.
   */
  async bindActivatedRevision(tradeId: string): Promise<{ tradeDigest: string; revision: number }> {
    const view = await this.sync(tradeId);
    const cur = this.evidence.terms(tradeId);
    if (view.revision !== cur.revision + 1) fail("INVALID_STATE", "no newer activated revision to bind");
    const sigs = this.db.all(
      "SELECT signer_role, payload_json, signature FROM release_signatures WHERE trade_id = ? AND kind = 'DESTINATION_CONSENT' AND digest = ?",
      tradeId,
      view.termsDigest,
    );
    const by = (r: string) => sigs.find((s) => s["signer_role"] === r);
    const b = by("BUYER_APPROVER");
    const s = by("SUPPLIER_SIGNER");
    if (!b || !s) fail("INVALID_STATE", "both party consents for the activated revision are not journaled");
    const terms = tradeTermsFromJsonCanonical(
      fromTypedJson(JSON.parse(String(b["payload_json"])) as TypedJson),
    );
    if (tradeRevisionDigest(terms) !== view.termsDigest)
      fail("DIGEST_MISMATCH", "journaled successor differs from the contract");
    const r = this.evidence.bindSuccessorRevision(terms, {
      buyerSignature: String(b["signature"]),
      supplierSignature: String(s["signature"]),
    });
    return { tradeDigest: r.tradeDigest, revision: terms.revision };
  }

  /* ================================= audit ================================= */

  private deny(
    ctx: AuthContext,
    tradeId: string,
    code: "FORBIDDEN" | "KEY_NOT_BOUND",
    message: string,
  ): never {
    this.log(ctx, "RELEASE_ACTION_DENIED", "trade", tradeId, { code });
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
}

/** Canonical trade terms (u128 as bigint) back to the boundary JSON shape. */
function tradeTermsFromJsonCanonical(v: CanonicalValue): TradeTerms {
  const json = JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString(10) : x)),
  ) as unknown;
  return tradeTermsFromJson(json);
}
