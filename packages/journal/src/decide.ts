import type { ReceiptOutcome } from "@dockside/near";
import type { OperationKind, OperationState } from "./states.js";

/**
 * Deterministic reconciliation decision (TDD section 13). Pure: the same facts always give the
 * same decision. Every terminal outcome needs the complete evidence set for it:
 *
 * - PAID: contract PAID, final transaction, a final receipt crediting the bound destination with
 *   the exact native amount, and the exact ledger move reserved -> released per funder.
 * - REFUNDED: contract REFUNDED, final transaction, a final receipt crediting the original funder
 *   with the exact amount, and the exact ledger move refundLocked -> refunded.
 * - FAILED: final transaction plus contract and ledger proof that the value never left: either the
 *   contract rejected the call before any effect (no attempt, value unchanged) or the runtime
 *   returned a failed transfer (receipt FAILURE, value restored exactly to its source bucket).
 *
 * Anything missing, private, stale or contradictory stays UNKNOWN/PROCESSING or goes to REVIEW;
 * nothing here can retry, and nothing infers failure from silence.
 */

export interface FunderBuckets {
  readonly partial: bigint;
  readonly available: bigint;
  readonly reserved: bigint;
  readonly released: bigint;
  readonly refundLocked: bigint;
  readonly refunded: bigint;
  readonly quarantined: bigint;
}

export type LedgerSnapshot = Readonly<Record<string, FunderBuckets>>;

export type SourceBucket = "RESERVED" | "AVAILABLE" | "PARTIAL" | "QUARANTINED";

export interface BucketSlice {
  readonly funder: string;
  readonly amountYocto: bigint;
  /** RELEASE: the reservation; REFUND: the exact bucket the refund slice came from. */
  readonly bucket: SourceBucket;
}

/** Contract-side status of the operation's subject, normalized. */
export type ContractStatus =
  | "NOT_EXECUTED"
  | "EXITED"
  | "PENDING"
  | "PAID"
  | "REFUNDED"
  | "FAILED"
  | "MISSING";

export type TxStatusFact =
  | "NONE"
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "EXPIRED"
  | "EXECUTING"
  | "FINAL_SUCCESS"
  | "FINAL_FAILURE";

export type ReceiptClass = "CONFIRMED" | "REJECTED" | "PENDING" | "ABSENT" | "MISMATCH" | "UNAVAILABLE";

export interface DecisionInput {
  readonly kind: OperationKind;
  readonly state: OperationState;
  readonly recipient: string;
  readonly amountYocto: bigint;
  readonly slices: readonly BucketSlice[];
  readonly ledgerBefore: LedgerSnapshot;
  readonly ledgerNow: LedgerSnapshot | null;
  readonly conservation: boolean | null;
  readonly contract: ContractStatus;
  readonly tx: TxStatusFact;
  readonly receipt: ReceiptClass;
  /** Every distinct receipt class observed from final transactions so far, including this one. */
  readonly receiptHistory: readonly ReceiptClass[];
  /** An open incident already freezes this operation. */
  readonly frozen: boolean;
  readonly pastDeadline: boolean;
}

export type IncidentKind =
  | "CONTRADICTION"
  | "POST_FAILED_EVIDENCE"
  | "CONSERVATION"
  | "DESTINATION_MISMATCH"
  | "SHORT_REFUND"
  | "EXCESS_REFUND";

export interface Decision {
  readonly target: OperationState;
  readonly basis: string;
  readonly incident: { readonly kind: IncidentKind; readonly detail: string } | null;
}

const keep = (s: OperationState, basis: string): Decision => ({ target: s, basis, incident: null });
const go = (s: OperationState, basis: string): Decision => ({ target: s, basis, incident: null });
const review = (basis: string, incident: Decision["incident"] = null): Decision => ({
  target: "REVIEW",
  basis,
  incident,
});

const ZERO: FunderBuckets = {
  partial: 0n,
  available: 0n,
  reserved: 0n,
  released: 0n,
  refundLocked: 0n,
  refunded: 0n,
  quarantined: 0n,
};

function f(l: LedgerSnapshot, funder: string): FunderBuckets {
  return l[funder] ?? ZERO;
}

function bucketValue(b: FunderBuckets, s: SourceBucket): bigint {
  switch (s) {
    case "RESERVED":
      return b.reserved;
    case "AVAILABLE":
      return b.available;
    case "PARTIAL":
      return b.partial;
    case "QUARANTINED":
      return b.quarantined;
  }
}

/** Exact ledger dispositions, per funder slice. */
export const ledgerChecks = {
  releasePaid(before: LedgerSnapshot, now: LedgerSnapshot, slices: readonly BucketSlice[]): boolean {
    return slices.every((s) => {
      const a = f(before, s.funder);
      const b = f(now, s.funder);
      return b.released - a.released === s.amountYocto && a.reserved - b.reserved === s.amountYocto;
    });
  },
  releaseRestored(before: LedgerSnapshot, now: LedgerSnapshot, slices: readonly BucketSlice[]): boolean {
    return slices.every((s) => {
      const a = f(before, s.funder);
      const b = f(now, s.funder);
      return (
        b.available - a.available === s.amountYocto &&
        a.reserved - b.reserved === s.amountYocto &&
        b.released === a.released
      );
    });
  },
  /** The value never left: nothing released, reservation either intact or restored by an exit. */
  valueUnmoved(before: LedgerSnapshot, now: LedgerSnapshot, slices: readonly BucketSlice[]): boolean {
    return slices.every((s) => {
      const a = f(before, s.funder);
      const b = f(now, s.funder);
      const intact = b.reserved === a.reserved;
      const exited = a.reserved - b.reserved === s.amountYocto && b.available - a.available === s.amountYocto;
      return b.released === a.released && b.refunded === a.refunded && (intact || exited);
    });
  },
  refundPaid(before: LedgerSnapshot, now: LedgerSnapshot, slices: readonly BucketSlice[]): boolean {
    return slices.every((s) => {
      const a = f(before, s.funder);
      const b = f(now, s.funder);
      return b.refunded - a.refunded === s.amountYocto && a.refundLocked - b.refundLocked === s.amountYocto;
    });
  },
  /** Revocation or authoritative refund failure: exactly the recorded source bucket gets it back. */
  refundRestored(before: LedgerSnapshot, now: LedgerSnapshot, slices: readonly BucketSlice[]): boolean {
    return slices.every((s) => {
      const a = f(before, s.funder);
      const b = f(now, s.funder);
      if (a.refundLocked - b.refundLocked !== s.amountYocto) return false;
      if (b.refunded !== a.refunded) return false;
      for (const other of ["AVAILABLE", "PARTIAL", "QUARANTINED"] as const) {
        const d = bucketValue(b, other) - bucketValue(a, other);
        if (other === s.bucket ? d !== s.amountYocto : d !== 0n) return false;
      }
      return true;
    });
  },
};

const NATIVE_TRANSFER_CALLS = new Set(["ft_transfer", "ft_transfer_call", "nft_transfer", "mt_transfer"]);

/** Classify a transaction's receipts against the operation's bound recipient and exact amount. */
export function classifyReceipts(
  receipts: readonly ReceiptOutcome[] | null,
  recipient: string,
  amountYocto: bigint,
): ReceiptClass {
  if (receipts === null) return "UNAVAILABLE";
  // Runtime refund receipts (predecessor "system": gas refunds and returned failed transfers)
  // are not value movements of the operation.
  const own = receipts.filter((r) => r.predecessorId !== "system");
  const transfers = own.filter((r) => r.transfers.length > 0);
  const tokenMoves = own.filter((r) => r.calls.some((c) => NATIVE_TRANSFER_CALLS.has(c.method)));
  if (tokenMoves.length > 0) return "MISMATCH";
  if (
    transfers.some(
      (r) => r.receiverId !== recipient || r.transfers.length !== 1 || r.transfers[0] !== amountYocto,
    )
  )
    return "MISMATCH";
  const mine = transfers.filter((r) => r.receiverId === recipient);
  if (mine.length > 1) return "MISMATCH";
  const m = mine[0];
  if (!m) return "ABSENT";
  return m.status === "SUCCESS" ? "CONFIRMED" : m.status === "FAILURE" ? "REJECTED" : "PENDING";
}

function contradictory(history: readonly ReceiptClass[]): boolean {
  const h = new Set(history);
  const moved = h.has("CONFIRMED");
  const notMoved = h.has("REJECTED") || h.has("ABSENT");
  return (moved && notMoved) || h.has("MISMATCH");
}

/** Decide the next target for an unresolved operation. */
export function decide(i: DecisionInput): Decision {
  const paidState: OperationState = i.kind === "RELEASE" ? "PAID" : "REFUNDED";
  const lost = i.tx === "UNAVAILABLE" || i.tx === "NOT_FOUND" || i.tx === "NONE" || i.tx === "EXPIRED";
  const waiting = (basis: string): Decision => {
    if (i.pastDeadline) return review(`${basis}; reconciliation deadline passed`);
    if (lost) return i.state === "PROCESSING" ? keep("PROCESSING", basis) : go("UNKNOWN", basis);
    return go("PROCESSING", basis);
  };

  if (i.frozen) return review("an open incident freezes this operation");
  if (contradictory(i.receiptHistory))
    return review("receipts for this operation contradict each other", {
      kind: i.receiptHistory.includes("MISMATCH") ? "DESTINATION_MISMATCH" : "CONTRADICTION",
      detail: [...new Set(i.receiptHistory)].sort().join(","),
    });
  if (i.conservation === false)
    return review("escrow ledger conservation check failed", {
      kind: "CONSERVATION",
      detail: "conservation=false",
    });

  switch (i.contract) {
    case "MISSING":
      return review("the contract does not know the operation's subject", {
        kind: "CONTRADICTION",
        detail: "subject missing on contract",
      });
    case "NOT_EXECUTED":
    case "EXITED": {
      if (i.tx === "FINAL_FAILURE" || i.tx === "EXPIRED") {
        if (i.ledgerNow && ledgerChecks.valueUnmoved(i.ledgerBefore, i.ledgerNow, i.slices))
          return go("FAILED", i.tx === "EXPIRED" ? "EXPIRED_NOT_INCLUDED" : "REJECTED_BEFORE_EFFECT");
        return review("rejected call but the ledger moved", { kind: "CONSERVATION", detail: "ledger moved" });
      }
      if (i.tx === "FINAL_SUCCESS")
        return review("final success but the contract shows no execution", {
          kind: "CONTRADICTION",
          detail: "tx success without contract effect",
        });
      return waiting("no contract execution observed yet");
    }
    case "PENDING":
      if (i.receipt === "MISMATCH")
        return review("transfer receipt does not match the bound recipient", {
          kind: "DESTINATION_MISMATCH",
          detail: "pending settlement with mismatched receipt",
        });
      return waiting("contract settlement pending");
    case "PAID":
    case "REFUNDED": {
      const expected = i.kind === "RELEASE" ? "PAID" : "REFUNDED";
      if (i.contract !== expected)
        return review("contract outcome kind contradicts the operation", {
          kind: "CONTRADICTION",
          detail: i.contract,
        });
      if (i.receipt === "MISMATCH")
        return review("wrong recipient, asset or amount", {
          kind: "DESTINATION_MISMATCH",
          detail: "receipt",
        });
      if (i.receipt === "REJECTED" || i.receipt === "ABSENT")
        return review("contract settled but no matching transfer receipt", {
          kind: "CONTRADICTION",
          detail: `contract ${i.contract}, receipt ${i.receipt}`,
        });
      if (i.tx === "UNAVAILABLE" || i.tx === "NOT_FOUND") return waiting("transaction outcome unavailable");
      if (i.tx === "EXECUTING" || i.receipt === "PENDING") return waiting("transaction not final");
      if (i.tx === "NONE" || i.tx === "EXPIRED" || i.receipt === "UNAVAILABLE")
        return review("destination receipt missing or private");
      if (i.tx === "FINAL_FAILURE") return review("contract settled but this operation's transaction failed");
      const ok =
        i.ledgerNow !== null &&
        (i.kind === "RELEASE"
          ? ledgerChecks.releasePaid(i.ledgerBefore, i.ledgerNow, i.slices)
          : ledgerChecks.refundPaid(i.ledgerBefore, i.ledgerNow, i.slices));
      if (!ok)
        return review("ledger does not show the exact settlement", {
          kind: "CONSERVATION",
          detail: "settlement delta mismatch",
        });
      return go(paidState, "AUTHORITATIVE_RECEIPT_AND_LEDGER");
    }
    case "FAILED": {
      if (i.receipt === "CONFIRMED")
        return review("contract failed but the recipient was credited", {
          kind: "CONTRADICTION",
          detail: "failed with confirmed receipt",
        });
      if (i.receipt === "MISMATCH")
        return review("wrong recipient, asset or amount", {
          kind: "DESTINATION_MISMATCH",
          detail: "receipt",
        });
      if (i.tx === "UNAVAILABLE" || i.tx === "NOT_FOUND") return waiting("transaction outcome unavailable");
      if (i.tx === "EXECUTING" || i.receipt === "PENDING") return waiting("transaction not final");
      if (i.tx === "NONE" || i.tx === "EXPIRED" || i.receipt === "UNAVAILABLE")
        return review("cannot prove non-transfer without the transfer receipt");
      const restored =
        i.ledgerNow !== null &&
        (i.kind === "RELEASE"
          ? ledgerChecks.releaseRestored(i.ledgerBefore, i.ledgerNow, i.slices)
          : ledgerChecks.refundRestored(i.ledgerBefore, i.ledgerNow, i.slices));
      if (!restored)
        return review("ledger does not show the exact restoration", {
          kind: "CONSERVATION",
          detail: "restoration delta mismatch",
        });
      return go("FAILED", "TRANSFER_RETURNED");
    }
  }
}

/**
 * Evidence about an operation that already reached a terminal state. Anything that contradicts the
 * disposition is a conservation incident: it freezes the trade and any successor; the terminal
 * state itself never changes.
 */
export function postTerminalIncident(
  outcome: "PAID" | "REFUNDED" | "FAILED" | "WITHDRAWN",
  basis: string,
  contract: ContractStatus,
  receiptHistory: readonly ReceiptClass[],
): { kind: IncidentKind; detail: string } | null {
  if (contradictory(receiptHistory))
    return { kind: "CONTRADICTION", detail: [...new Set(receiptHistory)].sort().join(",") };
  if (outcome === "FAILED" || outcome === "WITHDRAWN") {
    if (receiptHistory.includes("CONFIRMED"))
      return { kind: "POST_FAILED_EVIDENCE", detail: "recipient credited after FAILED" };
    if (contract === "PENDING" || contract === "PAID" || contract === "REFUNDED")
      return { kind: "POST_FAILED_EVIDENCE", detail: `contract ${contract} after ${outcome} (${basis})` };
    if (basis === "TRANSFER_RETURNED" && contract !== "FAILED")
      return { kind: "POST_FAILED_EVIDENCE", detail: `contract ${contract} after FAILED` };
  } else if (contract !== outcome) {
    return { kind: "CONTRADICTION", detail: `contract ${contract} after ${outcome}` };
  }
  return null;
}

/* ---------------- provider refund reconciliation (funded profile, M06) ---------------- */

export interface ProviderRefundReceipt {
  readonly receiptId: string;
  readonly receiverId: string;
  readonly asset: string;
  readonly amountYocto: bigint;
  readonly final: boolean;
}

export interface ProviderRefundResult {
  readonly status: "AWAITING" | "RETURNED_EXACT" | "SHORT" | "EXCESS" | "WRONG_TARGET";
  /** Proven returned value allocated to the original funders (reserved -> available). */
  readonly allocation: readonly { readonly funder: string; readonly amountYocto: bigint }[];
  /** Value that stays locked (short) or is quarantined (excess / unattributable). */
  readonly unmatchedYocto: bigint;
  readonly quarantineYocto: bigint;
  readonly countedReceipts: readonly string[];
}

/**
 * A provider refund in the funded corridor must reach the quote-bound refund authority in the
 * origin asset before it counts. Duplicate deliveries of one receipt count once; late receipts
 * add; a short refund leaves the unmatched amount locked in REVIEW; value above the expectation
 * is quarantined; a receipt to any other target or asset counts for nothing and needs REVIEW.
 * Allocation back to funders is proportional to their reserved slices, in integer smallest units,
 * with the remainder assigned deterministically to the lexicographically first funders.
 */
export function reconcileProviderRefund(input: {
  readonly refundAuthority: string;
  readonly asset: string;
  readonly expectedYocto: bigint;
  readonly slices: readonly { readonly funder: string; readonly amountYocto: bigint }[];
  readonly receipts: readonly ProviderRefundReceipt[];
}): ProviderRefundResult {
  const seen = new Set<string>();
  let wrong = false;
  let total = 0n;
  const counted: string[] = [];
  for (const r of input.receipts) {
    if (!r.final || seen.has(r.receiptId)) continue;
    seen.add(r.receiptId);
    if (r.receiverId !== input.refundAuthority || r.asset !== input.asset) {
      wrong = true;
      continue;
    }
    total += r.amountYocto;
    counted.push(r.receiptId);
  }
  const counted_ = total > input.expectedYocto ? input.expectedYocto : total;
  const sliceTotal = input.slices.reduce((a, s) => a + s.amountYocto, 0n);
  const sorted = [...input.slices].sort((a, b) => (a.funder < b.funder ? -1 : a.funder > b.funder ? 1 : 0));
  const base = sorted.map((s) => ({
    funder: s.funder,
    amountYocto: sliceTotal === 0n ? 0n : (counted_ * s.amountYocto) / sliceTotal,
  }));
  let rest = counted_ - base.reduce((a, s) => a + s.amountYocto, 0n);
  for (const b of base) {
    if (rest === 0n) break;
    (b as { amountYocto: bigint }).amountYocto += 1n;
    rest -= 1n;
  }
  const status: ProviderRefundResult["status"] = wrong
    ? "WRONG_TARGET"
    : total === 0n
      ? "AWAITING"
      : total === input.expectedYocto
        ? "RETURNED_EXACT"
        : total < input.expectedYocto
          ? "SHORT"
          : "EXCESS";
  return {
    status,
    allocation: base,
    unmatchedYocto: input.expectedYocto - counted_,
    quarantineYocto: total > input.expectedYocto ? total - input.expectedYocto : 0n,
    countedReceipts: counted,
  };
}
