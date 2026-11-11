import { fail } from "@dockside/core";

/**
 * Economic-operation state machines (TDD sections 11 and 12). The same table is installed in the
 * database (0005_journal.sql, operation_transition_rules) and enforced there by trigger; this
 * copy lets the services plan and refuse transitions before touching the database. A unit test
 * proves both tables are identical.
 */

export type OperationKind = "RELEASE" | "REFUND";

export const OPERATION_STATES = [
  "QUEUED",
  "WITHDRAWN",
  "SUBMITTING",
  "EXECUTING",
  "PROCESSING",
  "UNKNOWN",
  "REVIEW",
  "RECONCILING",
  "ADJUDICATION",
  "PAID",
  "REFUNDED",
  "FAILED",
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];

export const TERMINAL_STATES: readonly OperationState[] = ["PAID", "REFUNDED", "FAILED", "WITHDRAWN"];
/** States that hold the economic value lock after submission (INV-09). */
export const UNRESOLVED_OPERATION_STATES: readonly OperationState[] = [
  "SUBMITTING",
  "EXECUTING",
  "PROCESSING",
  "UNKNOWN",
  "REVIEW",
  "RECONCILING",
  "ADJUDICATION",
];

const RELEASE: Record<string, readonly OperationState[]> = {
  QUEUED: ["SUBMITTING", "WITHDRAWN"],
  SUBMITTING: ["PROCESSING", "UNKNOWN", "FAILED"],
  UNKNOWN: ["PROCESSING", "PAID", "REFUNDED", "FAILED", "REVIEW", "RECONCILING"],
  PROCESSING: ["PAID", "REFUNDED", "FAILED", "REVIEW"],
  REVIEW: ["RECONCILING", "ADJUDICATION"],
  RECONCILING: ["PROCESSING", "PAID", "REFUNDED", "FAILED", "REVIEW"],
  ADJUDICATION: ["RECONCILING", "REVIEW"],
};

const REFUND: Record<string, readonly OperationState[]> = {
  QUEUED: ["EXECUTING", "WITHDRAWN"],
  EXECUTING: ["PROCESSING", "UNKNOWN", "REFUNDED", "FAILED", "REVIEW"],
  UNKNOWN: ["PROCESSING", "REFUNDED", "FAILED", "REVIEW", "RECONCILING"],
  PROCESSING: ["REFUNDED", "FAILED", "REVIEW"],
  REVIEW: ["RECONCILING", "ADJUDICATION"],
  RECONCILING: ["PROCESSING", "REFUNDED", "FAILED", "REVIEW"],
  ADJUDICATION: ["RECONCILING", "REVIEW"],
};

export function transitionTable(kind: OperationKind): Record<string, readonly OperationState[]> {
  return kind === "RELEASE" ? RELEASE : REFUND;
}

export function isLegal(kind: OperationKind, from: OperationState, to: OperationState): boolean {
  return (transitionTable(kind)[from] ?? []).includes(to);
}

export function submitState(kind: OperationKind): OperationState {
  return kind === "RELEASE" ? "SUBMITTING" : "EXECUTING";
}

export function isTerminal(s: OperationState): boolean {
  return TERMINAL_STATES.includes(s);
}

/**
 * Shortest legal path from `from` to `to` passing only through the observational intermediates
 * PROCESSING and RECONCILING (never through REVIEW or ADJUDICATION unless that is the target).
 * Returns the states after `from`, or fails when the target is unreachable: a reconciler cannot
 * jump REVIEW/ADJUDICATION/terminal states it is not allowed to reach.
 */
export function planPath(kind: OperationKind, from: OperationState, to: OperationState): OperationState[] {
  if (from === to) return [];
  const table = transitionTable(kind);
  const seen = new Set<OperationState>([from]);
  const queue: { s: OperationState; path: OperationState[] }[] = [{ s: from, path: [] }];
  while (queue.length) {
    const { s, path } = queue.shift() as { s: OperationState; path: OperationState[] };
    for (const n of table[s] ?? []) {
      if (seen.has(n)) continue;
      const p = [...path, n];
      if (n === to) return p;
      seen.add(n);
      if (n === "PROCESSING" || n === "RECONCILING") queue.push({ s: n, path: p });
    }
  }
  return fail("ILLEGAL_TRANSITION", `no legal path ${from} -> ${to}`, { kind, from, to });
}
