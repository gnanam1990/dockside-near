// Read side of the attack console (M53), shared by the page (browser) and its tests (Node 22).
// Everything here works on answers read from NEAR by the caller; nothing here can send a
// transaction or holds a key. The console's relay sends the attempts; this file only judges
// what the chain says about them.

import { formatAmount as formatInAsset, tokenSymbol } from "./verify.mjs";

export { tokenSymbol };

export const ATTACKS = [
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

/**
 * What the escrow did with one transaction, from its `EXPERIMENTAL_tx_status` answer:
 * the escrow receipt, whether it failed, the contract's `DOCKSIDE:<CODE>` and, for a refused
 * release, the full list of blockers the contract reported.
 */
export function judgeAttempt(tx, { escrow, signer, method }) {
  const t = tx?.transaction ?? {};
  const call = (t.actions ?? []).map((a) => a?.FunctionCall).find(Boolean);
  const outcomes = Array.isArray(tx?.receipts_outcome) ? tx.receipts_outcome : [];
  const main = outcomes.find((o) => o?.outcome?.executor_id === escrow);
  const status = main?.outcome?.status ?? null;
  const failure = status && typeof status === "object" ? status.Failure : undefined;
  const text = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError ?? null;
  const m = typeof text === "string" ? /DOCKSIDE:([A-Z0-9_]+): (.*)$/s.exec(text) : null;
  const message = m ? m[2] : null;
  const blockers = message?.startsWith("release conjunction incomplete: ")
    ? message.slice("release conjunction incomplete: ".length).split(",")
    : [];
  const final = tx?.final_execution_status === "FINAL" || tx?.final_execution_status === "EXECUTED";
  return {
    signer: t.signer_id ?? null,
    receiver: t.receiver_id ?? null,
    method: call?.method_name ?? null,
    signerOk: signer === undefined || t.signer_id === signer,
    receiverOk: t.receiver_id === escrow,
    methodOk: method === undefined || call?.method_name === method,
    ranOnEscrow: !!main,
    final,
    refused: failure !== undefined,
    code: m ? m[1] : null,
    message,
    blockers,
    rawError: typeof text === "string" ? text : failure ? JSON.stringify(failure) : null,
    blockHash: main?.block_hash ?? null,
  };
}

const big = (x) => {
  try {
    return BigInt(x ?? 0);
  } catch {
    return -1n;
  }
};

/**
 * The trade's funds as the chain reports them, against what the demo started with: the whole
 * amount funded and reserved for the bound supplier, nothing released or refunded, a hold blocking.
 */
export function fundsState(config, { ledger, release, holds }) {
  const amount = big(config.amountYocto);
  const t = ledger?.totals ?? {};
  const live = (release?.intents ?? []).find((i) => i.releaseIntentId === release?.liveIntent) ?? null;
  const rows = [
    { id: "funded", label: "Funded", expected: amount, actual: big(t.funded) },
    { id: "reserved", label: "Reserved for the release", expected: amount, actual: big(t.reserved) },
    { id: "released", label: "Released (paid out)", expected: 0n, actual: big(t.released) },
    { id: "refunded", label: "Refunded", expected: 0n, actual: big(t.refunded) },
    { id: "refundLocked", label: "Locked for a refund", expected: 0n, actual: big(t.refundLocked) },
  ].map((r) => ({ ...r, ok: r.actual === r.expected }));
  const payoutOk =
    release?.payoutDestination === config.parties?.supplier && live?.destination === config.parties?.supplier;
  const blocking = (holds ?? []).filter((h) => h.resolution === null);
  const checks = {
    amounts: rows.every((r) => r.ok),
    payoutToBoundSupplier: payoutOk,
    conservation: ledger?.conservation === true,
    holdBlocking: blocking.length > 0 && (release?.blockers ?? []).includes("HOLD_ACTIVE"),
    notPaid: !(release?.intents ?? []).some((i) => i.state === "PAID"),
  };
  return {
    rows,
    payoutDestination: release?.payoutDestination ?? null,
    intentState: live?.state ?? null,
    holdStatus: blocking.map((h) => h.status),
    blockers: release?.blockers ?? [],
    checks,
    unchanged: Object.values(checks).every(Boolean),
  };
}

/** Attempts sent with the demo key since setup: its access key nonce minus the recorded baseline. */
export function attemptCount(accessKey, config) {
  if (!accessKey || accessKey.nonce === undefined || config.baselineNonce === null) return null;
  const n = big(accessKey.nonce) - big(config.baselineNonce);
  return n < 0n ? null : n;
}

/** The demo key on chain must be a function-call key restricted to the escrow. */
export function keyScope(accessKey, config) {
  const p = accessKey?.permission;
  const fc = p && typeof p === "object" ? p.FunctionCall : null;
  return {
    functionCallOnly: !!fc,
    receiver: fc?.receiver_id ?? null,
    restrictedToEscrow: !!fc && fc.receiver_id === config.escrow,
    allowanceYocto: fc?.allowance ?? null,
  };
}

export function explorerTx(config, txHash) {
  return `${config.explorer}${encodeURIComponent(txHash)}`;
}

export function formatNear(yocto) {
  const v = typeof yocto === "bigint" ? yocto : big(yocto);
  if (v < 0n) return "unreadable";
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac.slice(0, 6)}` : ""} NEAR`;
}

/**
 * The trade's asset: what get_ledger returned from the chain, else the asset of the terms the
 * demo registered (typed JSON in the config). Null when neither names one.
 */
export function tradeAsset(config, { ledger }) {
  if (ledger?.asset && typeof ledger.asset.kind === "string") return ledger.asset;
  const a = config?.terms?.struct?.asset?.struct;
  const kind = a?.kind?.str;
  if (typeof kind !== "string") return null;
  const asset = { kind, network: a.network?.str ?? null };
  if (a.tokenAccountId?.str !== undefined) asset.tokenAccountId = a.tokenAccountId.str;
  if (a.decimals?.u64 !== undefined) asset.decimals = Number(a.decimals.u64);
  return asset;
}

/** An amount in the trade's asset: NEAR as formatNear does, a NEP-141 token as "2.00 USDC". */
export function formatAmount(amount, asset, symbol = null) {
  const v = typeof amount === "bigint" ? amount : big(amount);
  if (v < 0n) return "unreadable";
  if (asset?.kind === "NEAR_NATIVE") return formatNear(v);
  return formatInAsset(v, asset, symbol);
}

/** The newest recorded attempt of each attack, for the replay mode. */
export function recordedFor(config, attackId) {
  const list = (config.recorded ?? []).filter((r) => r.attack === attackId);
  return list.length > 0 ? list[list.length - 1] : null;
}
