import { randomBytes } from "node:crypto";
import {
  type CanonicalValue,
  digestHexFor,
  fromTypedJson,
  generateEd25519KeyPair,
  newNonce,
  sha256,
  signFor,
  type TypedJson,
  toHex,
  toTypedJson,
} from "@dockside/core";
import { holdResolvePayload, refundRequestPayload, type TradeBinding } from "@dockside/near";

/**
 * The five attacks of the attack console (M53, ADR-0029). Each is one function call to the escrow,
 * sent from an account that has no authority over the demo trade, and each is the attacker's best
 * honest attempt: every field the attacker can know is filled in correctly from the chain, so the
 * contract's answer is about the one thing the attacker cannot have (a bound key, an unused
 * approval, a clear hold, a deposit of its own).
 *
 * The builders are pure: the caller passes what the chain says now (`ChainSnapshot`) and the demo
 * configuration (public facts of the demo trade, read from its run record). They hold no key of
 * the trade: a signature an attack needs is made with a fresh random key created for that attempt
 * and thrown away.
 */

/** Why the console did not (or could not) send an attempt. Codes are the console's own. */
export type AttackErrorCode =
  | "UNKNOWN_ATTACK"
  | "CONFIG_INVALID"
  | "DEMO_NOT_SET_UP"
  | "DEMO_STALE"
  | "DEMO_NOT_ARMED"
  | "RATE_LIMITED"
  | "BUSY"
  | "KEY_REFUSED"
  | "SEND_FAILED"
  | "ACCEPTED";

export class AttackError extends Error {
  constructor(
    readonly code: AttackErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "AttackError";
  }
}

export function fail(code: AttackErrorCode, message: string): never {
  throw new AttackError(code, message);
}

export const ATTACK_IDS = [
  "change-payout",
  "release-during-hold",
  "approve-wrong-key",
  "replay-approval",
  "refund-to-stranger",
] as const;
export type AttackId = (typeof ATTACK_IDS)[number];

export interface AttackSpec {
  readonly id: AttackId;
  readonly title: string;
  readonly method: string;
  /** The code the contract answers while the demo's signed windows are open (first 24 hours). */
  readonly expect: string;
  readonly what: string;
}

export const ATTACKS: readonly AttackSpec[] = [
  {
    id: "change-payout",
    title: "Change the payout account",
    method: "propose_destination_change",
    expect: "SIGNATURE_INVALID",
    what: "Proposes the trade's own terms with the payout moved to the attacker's account, signed as the buyer with a key the trade does not bind.",
  },
  {
    id: "release-during-hold",
    title: "Release during a hold",
    method: "execute_release",
    expect: "HOLD_ACTIVE",
    what: "Asks the escrow to pay out the approved release intent while the policy hold is active. Anyone may relay a release; the contract re-checks every condition itself.",
  },
  {
    id: "approve-wrong-key",
    title: "Approve with the wrong key",
    method: "resolve_hold",
    expect: "SIGNATURE_INVALID",
    what: "Approves lifting the hold (RELEASE_HOLD) with every field correct, signed as the risk resolver with a key the trade does not bind.",
  },
  {
    id: "replay-approval",
    title: "Replay an approval",
    method: "approve_release",
    expect: "INVALID_STATE",
    what: "Sends the buyer's real, accepted approval again, byte for byte, copied from its transaction on chain.",
  },
  {
    id: "refund-to-stranger",
    title: "Refund to a stranger",
    method: "request_refund",
    expect: "NOTHING_ELIGIBLE",
    what: "Asks for the trade's deposit back to the attacker's own account, as its funder. Refunds have no destination field: the escrow pays only the account its ledger says deposited.",
  },
];

export function attackSpec(id: string): AttackSpec {
  const a = ATTACKS.find((x) => x.id === id);
  if (!a) fail("UNKNOWN_ATTACK", `unknown attack ${id}`);
  return a;
}

/* ------------------------------------------------------------------------------------------ */
/* Demo configuration (site/proof/attack/attack-demo.json)                                     */
/* ------------------------------------------------------------------------------------------ */

export interface RecordedAttempt {
  readonly attack: AttackId;
  readonly txHash: string;
  readonly signer: string;
  readonly code: string | null;
  readonly blockTimeMs: number | null;
}

export interface DemoConfig {
  readonly schema: "dockside/attack-demo@1";
  readonly network: string;
  readonly status: "NOT_SET_UP" | "LIVE";
  readonly rpc: readonly string[];
  readonly explorer: string;
  /** Where the page sends attempts: a path on the same origin, an absolute URL, or null (replay only). */
  readonly relay: string | null;
  readonly escrow: string | null;
  readonly tradeId: string | null;
  readonly releaseIntentId: string | null;
  readonly holdId: string | null;
  readonly amountYocto: string | null;
  readonly parties: { readonly buyer: string; readonly supplier: string } | null;
  readonly attacker: { readonly accountId: string; readonly publicKey: string } | null;
  /** The access key nonce of the attacker key when the demo was set up: attempts = nonce - this. */
  readonly baselineNonce: string | null;
  readonly setup: readonly { step: string; method: string; signer: string; txHash: string }[];
  /** Revision-1 terms as registered (typed JSON, the `terms` argument of register_trade). */
  readonly terms: TypedJson | null;
  /** The buyer's accepted approve_release call: its transaction and its exact argument bytes. */
  readonly approval: { readonly txHash: string; readonly argsBase64: string } | null;
  readonly recorded: readonly RecordedAttempt[];
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const TX_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** Fail-closed check of a demo configuration; `LIVE` needs every fact of the trade. */
export function parseDemoConfig(raw: unknown): DemoConfig {
  const bad = (m: string): never => fail("CONFIG_INVALID", `attack demo config: ${m}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("not an object");
  const c = raw as Record<string, unknown>;
  if (c["schema"] !== "dockside/attack-demo@1") bad("schema must be dockside/attack-demo@1");
  if (c["status"] !== "NOT_SET_UP" && c["status"] !== "LIVE") bad("status must be NOT_SET_UP or LIVE");
  if (!Array.isArray(c["rpc"]) || c["rpc"].length === 0 || !c["rpc"].every((u) => typeof u === "string"))
    bad("rpc must list endpoints");
  if (!Array.isArray(c["recorded"])) bad("recorded must be a list");
  if (c["status"] === "LIVE") {
    for (const k of ["escrow", "tradeId", "releaseIntentId", "holdId", "amountYocto", "baselineNonce"])
      if (typeof c[k] !== "string" || c[k] === "") bad(`${k} is required for a live demo`);
    for (const k of ["escrow"]) if (!ACCOUNT_RE.test(String(c[k]))) bad(`${k} is not an account id`);
    const a = c["attacker"] as Record<string, unknown> | null;
    if (!a || typeof a["accountId"] !== "string" || !ACCOUNT_RE.test(a["accountId"]))
      bad("attacker.accountId is required");
    if (!a || typeof a["publicKey"] !== "string" || !a["publicKey"].startsWith("ed25519:"))
      bad("attacker.publicKey is required");
    const p = c["parties"] as Record<string, unknown> | null;
    if (!p || typeof p["buyer"] !== "string" || typeof p["supplier"] !== "string")
      bad("parties are required");
    if (
      a &&
      p &&
      (a["accountId"] === p["buyer"] || a["accountId"] === p["supplier"] || a["accountId"] === c["escrow"])
    )
      bad("the attacker account must not be a party of the trade or the escrow");
    const ap = c["approval"] as Record<string, unknown> | null;
    if (
      !ap ||
      typeof ap["txHash"] !== "string" ||
      !TX_RE.test(ap["txHash"]) ||
      typeof ap["argsBase64"] !== "string"
    )
      bad("approval needs txHash and argsBase64");
    if (typeof c["terms"] !== "object" || c["terms"] === null) bad("terms are required");
  }
  for (const r of c["recorded"] as unknown[]) {
    const x = r as Record<string, unknown>;
    if (
      !ATTACK_IDS.includes(x["attack"] as AttackId) ||
      typeof x["txHash"] !== "string" ||
      !TX_RE.test(x["txHash"])
    )
      bad("recorded attempts need an attack id and a transaction hash");
  }
  return c as unknown as DemoConfig;
}

/* ------------------------------------------------------------------------------------------ */
/* Chain snapshot and payloads                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface ReleaseView {
  readonly tradeId: string;
  readonly revision: number;
  readonly termsDigest: string;
  readonly payoutDestination: string;
  readonly liveIntent: string | null;
  readonly blockers: readonly string[];
  readonly intents: readonly {
    readonly releaseIntentId: string;
    readonly state: string;
    readonly destination: string;
    readonly approval: { readonly digest: string } | null;
  }[];
}
export interface HoldView {
  readonly holdId: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly resolution: unknown;
}
export interface EvidenceView {
  readonly current: { readonly digest: string; readonly status: string } | null;
}
export interface LedgerView {
  readonly totals: Readonly<Record<string, string>>;
  readonly funders: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly conservation: boolean;
}

/** What the chain says now: block time and the trade's views, all read at one final block. */
export interface ChainSnapshot {
  readonly nowMs: number;
  readonly release: ReleaseView;
  readonly holds: readonly HoldView[];
  readonly evidence: EvidenceView;
  readonly ledger: LedgerView;
}

export interface BuiltAttack {
  readonly attack: AttackId;
  readonly method: string;
  readonly args: Record<string, unknown>;
  /** The exact argument bytes to send (a replay must not be re-serialised differently). */
  readonly argsBytes: Uint8Array;
}

const WINDOW_MS = 15 * 60_000;

function binding(c: DemoConfig, s: ChainSnapshot): TradeBinding {
  return {
    contractId: c.escrow as string,
    tradeId: s.release.tradeId,
    tradeRevision: s.release.revision,
    tradeDigest: s.release.termsDigest,
  };
}

function window(s: ChainSnapshot) {
  return { issuedAt: s.nowMs, expiresAt: s.nowMs + WINDOW_MS, nonce: newNonce() };
}

/** A fresh Ed25519 key for one attempt. It is bound to nothing and is never stored. */
function throwawayKey() {
  return generateEd25519KeyPair().privateKey;
}

const bytesOf = (args: Record<string, unknown>) => new Uint8Array(Buffer.from(JSON.stringify(args), "utf8"));

/** The registered terms, checked against the digest the chain holds for the trade. */
export function registeredTerms(c: DemoConfig, s: ChainSnapshot): Record<string, CanonicalValue> {
  if (!c.terms) fail("CONFIG_INVALID", "the demo config carries no terms");
  const terms = fromTypedJson(c.terms) as Record<string, CanonicalValue>;
  if (digestHexFor("TRADE_REVISION", terms) !== s.release.termsDigest)
    fail("DEMO_STALE", "the demo config's terms are not the trade's active revision");
  return terms;
}

/** The accepted approval's exact bytes, checked against the approval digest the chain recorded. */
export function acceptedApproval(
  c: DemoConfig,
  s: ChainSnapshot,
): { args: Record<string, unknown>; bytes: Uint8Array } {
  if (!c.approval) fail("CONFIG_INVALID", "the demo config carries no approval");
  const bytes = new Uint8Array(Buffer.from(c.approval.argsBase64, "base64"));
  const text = Buffer.from(bytes).toString("utf8");
  const args = JSON.parse(text) as Record<string, unknown>;
  if (JSON.stringify(args) !== text) fail("CONFIG_INVALID", "the approval bytes are not in their sent form");
  const payload = fromTypedJson(args["payload"] as TypedJson);
  const intent = s.release.intents.find((i) => i.releaseIntentId === s.release.liveIntent);
  if (!intent?.approval || digestHexFor("BUYER_APPROVAL", payload) !== intent.approval.digest)
    fail("DEMO_STALE", "the config's approval is not the approval the chain recorded");
  return { args, bytes };
}

export function buildAttack(id: AttackId, c: DemoConfig, s: ChainSnapshot): BuiltAttack {
  const attacker = c.attacker?.accountId;
  if (c.status !== "LIVE" || !attacker || !c.escrow) fail("DEMO_NOT_SET_UP", "the demo trade is not set up");
  const b = binding(c, s);
  const trade_id = s.release.tradeId;
  const done = (
    method: string,
    args: Record<string, unknown>,
    argsBytes: Uint8Array = bytesOf(args),
  ): BuiltAttack => ({
    attack: id,
    method,
    args,
    argsBytes,
  });
  switch (id) {
    case "change-payout": {
      const terms = registeredTerms(c, s);
      const payout = terms["payout"] as Record<string, CanonicalValue>;
      const successor: Record<string, CanonicalValue> = {
        ...terms,
        revision: (terms["revision"] as number) + 1,
        predecessorDigest: s.release.termsDigest,
        payout: { ...payout, destination: attacker },
      };
      return done("propose_destination_change", {
        trade_id,
        successor_terms: toTypedJson(successor),
        proposer_role: "BUYER",
        signature: signFor(throwawayKey(), "TRADE_REVISION", successor),
      });
    }
    case "release-during-hold": {
      if (!s.release.liveIntent) fail("DEMO_STALE", "the demo trade has no live release intent");
      return done("execute_release", { trade_id, release_intent_id: s.release.liveIntent });
    }
    case "approve-wrong-key": {
      const hold = s.holds.find((h) => h.holdId === c.holdId);
      if (!hold) fail("DEMO_STALE", "the demo hold is not on chain");
      const current = s.evidence.current;
      const payload = holdResolvePayload(b, {
        holdId: hold.holdId,
        holdReasonCode: hold.reasonCode,
        manifestDigest: current && current.status === "VALID" ? current.digest : null,
        resolutionCode: "RELEASE_HOLD",
        evidenceDigest: toHex(
          sha256(new TextEncoder().encode(`attack console ${randomBytes(8).toString("hex")}`)),
        ),
        ...window(s),
      });
      return done("resolve_hold", {
        trade_id,
        payload: toTypedJson(payload),
        signature: signFor(throwawayKey(), "HOLD_RESOLVE", payload),
      });
    }
    case "replay-approval": {
      const a = acceptedApproval(c, s);
      return done("approve_release", a.args, a.bytes);
    }
    case "refund-to-stranger": {
      const payload = refundRequestPayload(b, {
        refundIntentId: `rfd_${randomBytes(16).toString("hex")}`,
        reason: "EXCESS_FUNDING_RETURN",
        funder: attacker,
        amountYocto: BigInt(c.amountYocto ?? "0"),
        sourceBucket: "QUARANTINED",
        initiatorRole: "FUNDER",
        ...window(s),
      });
      return done("request_refund", {
        trade_id,
        payload: toTypedJson(payload),
        buyer_signature: null,
        supplier_signature: null,
        risk_signature: null,
      });
    }
  }
}

/**
 * The demo is armed when nothing an attacker sends could move value: the trade is unreleased, its
 * live intent pays the bound supplier, and a hold blocks the release. The relay refuses to send
 * anything otherwise (the owner resolved the hold, the trade was paid, or the config is stale).
 */
export function demoArmed(c: DemoConfig, s: ChainSnapshot): { armed: boolean; why: string | null } {
  if (c.status !== "LIVE") return { armed: false, why: "the demo trade is not set up" };
  if (s.release.tradeId !== c.tradeId) return { armed: false, why: "the chain answered for another trade" };
  const live = s.release.intents.find((i) => i.releaseIntentId === s.release.liveIntent);
  if (!live || live.releaseIntentId !== c.releaseIntentId)
    return { armed: false, why: "the demo's release intent is no longer live" };
  if (s.release.intents.some((i) => i.state === "PAID")) return { armed: false, why: "the trade was paid" };
  if (live.destination !== c.parties?.supplier || s.release.payoutDestination !== c.parties?.supplier)
    return { armed: false, why: "the payout is no longer the bound supplier" };
  const blocking = s.holds.filter((h) => h.resolution === null);
  if (blocking.length === 0 || !s.release.blockers.includes("HOLD_ACTIVE"))
    return { armed: false, why: "no hold blocks the release" };
  return { armed: true, why: null };
}

/** The contract's refusal in a failed escrow receipt: `DOCKSIDE:<CODE>: <message>`. */
export function refusalOf(text: string | null | undefined): { code: string | null; message: string | null } {
  if (typeof text !== "string") return { code: null, message: null };
  const m = /DOCKSIDE:([A-Z0-9_]+): (.*)$/s.exec(text);
  return m ? { code: m[1] ?? null, message: m[2] ?? null } : { code: null, message: null };
}
