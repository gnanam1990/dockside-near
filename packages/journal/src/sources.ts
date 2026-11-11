import { createHash } from "node:crypto";
import type { EscrowContract, NearTxClient, TxOutcome } from "@dockside/near";
import {
  type ContractStatus,
  classifyReceipts,
  type LedgerSnapshot,
  type ReceiptClass,
  type TxStatusFact,
} from "./decide.js";
import type { ObservationInput, OperationRecord } from "./journal.js";

/**
 * Independent evidence sources for one operation (TDD section 13, step 2): the escrow contract's
 * own state, its ledger, the original transaction looked up by hash, and that transaction's
 * receipts as destination evidence. Each read can fail on its own; a failed read is recorded as
 * UNAVAILABLE and never coerced into a positive or negative fact.
 */

export interface ChainPorts {
  readonly escrow: EscrowContract;
  readonly tx: NearTxClient;
  /** NEAR transaction validity window in blocks (86400 on testnet/mainnet). */
  readonly txValidityBlocks: number;
}

export interface GatheredFacts {
  readonly contract: ContractStatus;
  readonly contractState: string | null;
  readonly attemptId: string | null;
  readonly successors: string[];
  readonly ledger: LedgerSnapshot | null;
  readonly conservation: boolean | null;
  readonly tx: TxStatusFact;
  readonly outcome: TxOutcome | null;
  readonly receipt: ReceiptClass;
  readonly receiptFinal: boolean;
  readonly observations: ObservationInput[];
}

const RELEASE_PRE_SUBMIT = [
  "VALUE_LOCKED",
  "DIRECT_TESTNET_AUTHORIZED",
  "FUNDED_AUTHORIZATION_REQUIRED",
  "FUNDED_AUTHORIZED",
];
const RELEASE_EXITED = ["CANCELLED_PRE_SUBMIT", "ABANDONED_PRE_SUBMIT", "SUPERSEDED_PRE_SUBMIT"];
const REFUND_PRE_EXEC = ["REQUESTED", "TIMELOCKED", "AUTHORIZED"];

export function digestOf(v: unknown): string {
  const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString(10) : x));
  return createHash("sha256").update(s).digest("hex");
}

export function releaseContractStatus(state: string | null, attempts: number): ContractStatus {
  if (state === null) return "MISSING";
  if (RELEASE_PRE_SUBMIT.includes(state)) return attempts === 0 ? "NOT_EXECUTED" : "PENDING";
  if (RELEASE_EXITED.includes(state)) return "EXITED";
  if (state === "PAID" || state === "FAILED" || state === "REFUNDED") return state;
  return "PENDING";
}

export function refundContractStatus(state: string | null): ContractStatus {
  if (state === null) return "MISSING";
  if (REFUND_PRE_EXEC.includes(state)) return "NOT_EXECUTED";
  if (state === "REVOKED") return "EXITED";
  if (state === "REFUNDED" || state === "FAILED") return state;
  return "PENDING";
}

function errCode(e: unknown): string {
  return (e as { code?: string }).code ?? "FOREIGN";
}

export async function gatherFacts(
  op: OperationRecord,
  ports: ChainPorts,
  now: number,
  correlationId: string,
): Promise<GatheredFacts> {
  const obs: ObservationInput[] = [];
  const add = (
    source: ObservationInput["source"],
    subject: string,
    confidence: ObservationInput["confidence"],
    fact: Record<string, unknown>,
    revision: number | null = null,
  ) =>
    obs.push({
      source,
      subject,
      observedAt: now,
      freshnessMs: 0,
      confidence,
      revision,
      correlationId,
      rawDigest: digestOf({ source, subject, fact }),
      fact,
    });

  // 1. Contract state of the subject.
  let contract: ContractStatus = "MISSING";
  let contractState: string | null = null;
  let attemptId: string | null = null;
  const successors: string[] = [];
  let contractRead = false;
  try {
    if (op.kind === "RELEASE") {
      const v = await ports.escrow.getRelease(op.tradeId);
      const i = v.intents.find((x) => x.releaseIntentId === op.subjectId) ?? null;
      contractState = i?.state ?? null;
      attemptId = i?.attempts.at(-1) ?? null;
      contract = releaseContractStatus(contractState, i?.attempts.length ?? 0);
      if (i)
        for (const o of v.intents)
          if (o.releaseIntentId !== i.releaseIntentId && o.createdAt >= i.createdAt)
            successors.push(o.releaseIntentId);
      add(
        "CONTRACT",
        op.subjectId,
        "AUTHORITATIVE",
        { state: contractState, attempts: i?.attempts ?? [], stateVersion: i?.stateVersion ?? null },
        i?.tradeRevision ?? null,
      );
    } else {
      const v = await ports.escrow.getRefunds(op.tradeId);
      const r = v.find((x) => x.refundIntentId === op.subjectId) ?? null;
      contractState = r?.state ?? null;
      contract = refundContractStatus(contractState);
      add("CONTRACT", op.subjectId, "AUTHORITATIVE", { state: contractState, funder: r?.funder ?? null });
    }
    contractRead = true;
  } catch (e) {
    add("CONTRACT", op.subjectId, "UNAVAILABLE", { error: errCode(e) });
  }

  // 2. Ledger buckets of the funders this operation moves.
  let ledger: LedgerSnapshot | null = null;
  let conservation: boolean | null = null;
  try {
    const l = await ports.escrow.getLedger(op.tradeId);
    const snap: Record<string, LedgerSnapshot[string]> = {};
    for (const [k, b] of Object.entries(l.funders))
      snap[k] = {
        partial: b.partial,
        available: b.available,
        reserved: b.reserved,
        released: b.released,
        refundLocked: b.refundLocked,
        refunded: b.refunded,
        quarantined: b.quarantined,
      };
    ledger = snap;
    conservation = l.conservation;
    const mine: Record<string, Record<string, string>> = {};
    for (const s of op.slices) {
      const b = snap[s.funder];
      if (b)
        mine[s.funder] = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toString(10)])) as Record<
          string,
          string
        >;
    }
    add("LEDGER", op.tradeId, "AUTHORITATIVE", { funders: mine, conservation: l.conservation });
  } catch (e) {
    add("LEDGER", op.tradeId, "UNAVAILABLE", { error: errCode(e) });
  }

  // 3. The original transaction, by hash. Silence is never failure; only expiry of the
  //    transaction's validity window proves it can no longer be included.
  let tx: TxStatusFact = "NONE";
  let outcome: TxOutcome | null = null;
  if (op.txHash && op.txSigner) {
    try {
      outcome = await ports.tx.status(op.txHash, op.txSigner);
      tx = outcome.kind;
      if (outcome.kind === "NOT_FOUND" && op.txRefHeight !== null) {
        const b = await ports.tx.latestBlock();
        if (b.height > op.txRefHeight + ports.txValidityBlocks) tx = "EXPIRED";
      }
      add("TX_STATUS", op.txHash, "ATTRIBUTED", {
        kind: tx,
        returnValue: outcome.kind === "NOT_FOUND" ? null : outcome.returnValue,
        error: outcome.kind === "NOT_FOUND" ? null : outcome.error,
      });
    } catch (e) {
      tx = "UNAVAILABLE";
      add("TX_STATUS", op.txHash, "UNAVAILABLE", { error: errCode(e) });
    }
  }

  // 4. Destination (or original-funder) receipt from that transaction.
  let receipt: ReceiptClass = "UNAVAILABLE";
  let receiptFinal = false;
  if (outcome && outcome.kind !== "NOT_FOUND") {
    receipt = classifyReceipts(outcome.receipts, op.recipient, op.amountYocto);
    receiptFinal = outcome.kind === "FINAL_SUCCESS" || outcome.kind === "FINAL_FAILURE";
    add("RECEIPT", op.recipient, receipt === "UNAVAILABLE" ? "UNAVAILABLE" : "AUTHORITATIVE", {
      class: receipt,
      final: receiptFinal,
      receipts: (outcome.receipts ?? [])
        .filter((r) => r.transfers.length > 0)
        .map((r) => ({
          receiverId: r.receiverId,
          transfers: r.transfers.map((t) => t.toString(10)),
          status: r.status,
        })),
    });
  }
  return {
    contract: contractRead ? contract : "PENDING",
    contractState,
    attemptId,
    successors,
    ledger,
    conservation,
    tx,
    outcome,
    receipt,
    receiptFinal,
    observations: obs,
  };
}
