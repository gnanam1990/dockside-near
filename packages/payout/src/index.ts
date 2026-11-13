import { fail } from "@dockside/core";

/**
 * M06 (optional) 1Click payout compatibility: interfaces and a blocked adapter only.
 *
 * Nothing here talks to 1Click. A live dry probe needs the pinned official client, partner
 * registration and an API credential, none of which this build may create or hold, so the only
 * adapter shipped is `BlockedOneClickAdapter`, whose answer is always NOT_RUN. The dry
 * compatibility claim is orthogonal to escrow: no state here is read by release intents, direct
 * testnet release, ledger buckets, WORKING_TESTNET, funded authorization, processing, paid or
 * destination receipt. The funded rail stays FUNDED_RAIL_BLOCKED.
 */
export const DRY_COMPATIBILITY_STATES = ["NOT_RUN", "UNKNOWN", "INCOMPATIBLE", "PASS"] as const;
export type DryCompatibilityState = (typeof DRY_COMPATIBILITY_STATES)[number];

/** The future bound recipient a dry quote must match exactly (from the accepted trade revision). */
export interface DryQuoteExpectation {
  readonly finalRecipient: string;
  readonly originNetwork: string;
  readonly originAsset: string;
  readonly destinationNetwork: string;
  readonly destinationAsset: string;
  readonly amountInYocto: bigint;
  /** Refunds from the provider must return to escrow / refund authority, never the executor. */
  readonly refundTo: string;
}

/**
 * What an adapter observed. `RESPONSE` carries fields already decoded by the pinned client's
 * own schema; anything the adapter could not decode unambiguously is `AMBIGUOUS`.
 */
export type DryProbeObservation =
  | { readonly kind: "NOT_ATTEMPTED"; readonly reason: string }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "TRANSPORT_ERROR"; readonly code: string }
  | { readonly kind: "AMBIGUOUS"; readonly detail: string }
  | {
      readonly kind: "RESPONSE";
      readonly quote: {
        readonly recipient: string;
        readonly originNetwork: string;
        readonly originAsset: string;
        readonly destinationNetwork: string;
        readonly destinationAsset: string;
        readonly amountInYocto: bigint;
        readonly refundTo: string;
      };
    };

export interface DryCompatibilityResult {
  readonly state: DryCompatibilityState;
  readonly mismatches: readonly string[];
  readonly reason: string;
}

/** Pure classification: timeouts and ambiguity are UNKNOWN, a verified mismatch INCOMPATIBLE. */
export function classifyDryProbe(
  expect: DryQuoteExpectation,
  obs: DryProbeObservation,
): DryCompatibilityResult {
  switch (obs.kind) {
    case "NOT_ATTEMPTED":
      return { state: "NOT_RUN", mismatches: [], reason: obs.reason };
    case "TIMEOUT":
      return { state: "UNKNOWN", mismatches: [], reason: "probe timed out" };
    case "TRANSPORT_ERROR":
      return { state: "UNKNOWN", mismatches: [], reason: `transport error ${obs.code}` };
    case "AMBIGUOUS":
      return { state: "UNKNOWN", mismatches: [], reason: "response schema ambiguous" };
    case "RESPONSE": {
      const q = obs.quote;
      const mismatches: string[] = [];
      if (q.recipient !== expect.finalRecipient) mismatches.push("finalRecipient");
      if (q.originNetwork !== expect.originNetwork) mismatches.push("originNetwork");
      if (q.originAsset !== expect.originAsset) mismatches.push("originAsset");
      if (q.destinationNetwork !== expect.destinationNetwork) mismatches.push("destinationNetwork");
      if (q.destinationAsset !== expect.destinationAsset) mismatches.push("destinationAsset");
      if (q.amountInYocto !== expect.amountInYocto) mismatches.push("amountInYocto");
      if (q.refundTo !== expect.refundTo) mismatches.push("refundTo");
      return mismatches.length
        ? { state: "INCOMPATIBLE", mismatches, reason: "verified field mismatch" }
        : { state: "PASS", mismatches: [], reason: "all bound fields match" };
    }
  }
}

/** Only PASS may expose the DRY_COMPATIBLE label; it is a display claim, never authority. */
export function dryCompatibleLabel(state: DryCompatibilityState): "DRY_COMPATIBLE" | null {
  return state === "PASS" ? "DRY_COMPATIBLE" : null;
}

export interface OneClickAdapter {
  readonly id: string;
  dryProbe(expect: DryQuoteExpectation): Promise<DryProbeObservation>;
}

/** The only adapter in this build: no client, no credential, no network. */
export class BlockedOneClickAdapter implements OneClickAdapter {
  readonly id = "one-click-blocked";
  async dryProbe(): Promise<DryProbeObservation> {
    return {
      kind: "NOT_ATTEMPTED",
      reason: "1Click client, partner registration and credential are not provisioned (M06 BLOCKED)",
    };
  }
}

/**
 * Every economic field a future FundedPayoutAuthorization must bind (TDD; T-026). Recorded as the
 * design contract for the blocked mainnet path; no payload builder or verifier exists yet.
 */
export const FUNDED_AUTHORIZATION_FIELDS = [
  "releaseIntentId",
  "quoteId",
  "quoteDigest",
  "depositAddress",
  "finalRecipient",
  "originNetwork",
  "originAsset",
  "destinationNetwork",
  "destinationAsset",
  "amountInYocto",
  "minAmountOut",
  "feesYocto",
  "slippageBps",
  "capYocto",
  "refundTo",
  "nonce",
  "issuedAt",
  "expiresAt",
  "signerRole",
  "keyVersionId",
] as const;

/** The funded rail is blocked by configuration and by construction. */
export function fundedAuthorizationGate(): never {
  return fail(
    "FUNDED_RAIL_BLOCKED",
    "funded payouts are BLOCKED: no verified corridor or explicit authorization",
  );
}

/**
 * M52 supplier cash-out: a read-only 1Click client (tokens, dry quotes, status), the request the
 * supplier sends from their own client, the check of the quote the supplier obtained, the deposit
 * call for the supplier wallet and the reconciliation rule. Separate from the M06 funded rail above,
 * which stays BLOCKED: nothing here lets the escrow, the relayer or the server pay through 1Click.
 */
export * from "./one-click.js";
