// The USDC part of `pnpm judge`: re-reads the NEP-141 escrow `gnanam1990-dock-escrow3.testnet` (M56)
// and compares every value with the committed evidence docs/evidence/M56/onchain-reverify.json.
//
// The proof manifest (site/proof/proof-manifest.json) holds one deployment per network and its
// verifier reads native-NEAR transfers, so escrow3 is checked here instead, with the same read-only
// RPC client (site/proof/lib/near-rpc.mjs: block, query and tx status only; no key, no transaction)
// and the same conservation rules (site/proof/lib/verify.mjs).
//
// What is checked, each as one row with the expected value beside the actual one:
//   - the code hash of escrow3 and its NEP-141 token config (final block)
//   - the relayer key: a function-call key whose only receiver is escrow3
//   - the three setup transactions (deploy + new, storage deposit, relayer key)
//   - every journey transaction: signer, receiver, method, success or failure, and the exact
//     `ft_transfer` payouts the escrow made (one row per journey)
//   - each of the six refused calls: the contract's refusal code
//   - the four trade ledgers (final block): totals as recorded, conservation recomputed
//   - the USDC balances of the supplier, the buyer and escrow3 at the block of the evidence
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRpc } from "../../site/proof/lib/near-rpc.mjs";
import { checkConservation, ERROR, FAIL, PASS } from "../../site/proof/lib/verify.mjs";

export const USDC_EVIDENCE = "docs/evidence/M56/onchain-reverify.json";
export const USDC_RPC = ["https://test.rpc.fastnear.com", "https://archival-rpc.testnet.fastnear.com"];
const TX_LINK = "https://testnet.nearblocks.io/txns/";
const TOTALS = ["funded", "released", "refunded", "quarantined", "available", "reserved", "refundLocked"];

export function loadUsdcEvidence(root) {
  return JSON.parse(readFileSync(join(root, USDC_EVIDENCE), "utf8"));
}

const short = (s) => (s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);
/** Account names stay whole; the 64-character implicit token account is shortened. */
const account = (s) => (/^[0-9a-f]{64}$/.test(s ?? "") ? short(s) : s);
const usdc = (micro) => {
  const n = BigInt(micro);
  const frac = (n % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${n / 1_000_000n}${frac ? `.${frac}` : ""} USDC`;
};

function decodeArgs(b64) {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

/** Refusal code of a failed escrow receipt: "Smart contract panicked: DOCKSIDE:FORBIDDEN: …" -> FORBIDDEN. */
export function panicCode(status) {
  const msg = status?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return typeof msg === "string" ? (/DOCKSIDE:([A-Z_]+)/.exec(msg)?.[1] ?? null) : null;
}

/** The facts of one transaction that the evidence records, read from an EXPERIMENTAL_tx_status answer. */
export function summariseUsdcTx(result, escrow, token) {
  const tx = result.transaction ?? {};
  const actions = (tx.actions ?? []).map((a) =>
    typeof a === "string"
      ? a
      : a.FunctionCall
        ? `FunctionCall:${a.FunctionCall.method_name}`
        : Object.keys(a)[0],
  );
  const outcomes = new Map((result.receipts_outcome ?? []).map((o) => [o.id, o.outcome ?? {}]));
  const status = result.status ?? {};
  const failedCodes = [];
  const logCodes = [];
  for (const o of outcomes.values()) {
    if (o.executor_id !== escrow) continue;
    const code = panicCode(o.status);
    if (code) failedCodes.push(code);
    for (const line of o.logs ?? []) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(line.slice(11));
        if (ev.standard === "dockside" && typeof ev.data?.code === "string") logCodes.push(ev.data.code);
      } catch {
        // not an event this check reads
      }
    }
  }
  const ftTransfers = [];
  for (const r of result.receipts ?? []) {
    if (r.predecessor_id !== escrow || r.receiver_id !== token) continue;
    for (const a of r.receipt?.Action?.actions ?? []) {
      if (a.FunctionCall?.method_name !== "ft_transfer") continue;
      const args = decodeArgs(a.FunctionCall.args);
      const st = outcomes.get(r.receipt_id)?.status ?? {};
      ftTransfers.push({
        receiver: args.receiver_id,
        amount: args.amount,
        outcome: "SuccessValue" in st ? "SuccessValue" : Object.keys(st)[0],
      });
    }
  }
  return {
    signer: tx.signer_id,
    receiver: tx.receiver_id,
    actions,
    txStatus: "SuccessValue" in status || "SuccessReceiptId" in status ? "SuccessValue" : "Failure",
    finality: result.final_execution_status,
    failedCodes,
    logCodes,
    ftTransfers,
  };
}

const showTransfers = (list) =>
  list.length === 0
    ? ""
    : `, paid ${list.map((t) => `${usdc(t.amount)} to ${t.receiver} (${t.outcome})`).join("; ")}`;
const describe = (s) =>
  `${s.actions.map((a) => a.replace(/^FunctionCall:/, "")).join(" + ")} by ${s.signer} on ${
    s.receiver === s.signer ? "itself" : account(s.receiver)
  }, ${s.txStatus === "Failure" ? "failed" : "success"}, ${s.finality}${showTransfers(s.ftTransfers)}`;

/** Expected facts of one recorded transaction, in the same shape as summariseUsdcTx. */
function expectedOf(t) {
  return {
    signer: t.signer,
    receiver: t.receiver,
    actions: t.actions,
    txStatus: t.txStatus === "SuccessValue" ? "SuccessValue" : "Failure",
    finality: t.finalExecutionStatus,
    ftTransfers: (t.ftTransfersFromEscrow ?? []).map((f) => ({
      receiver: f.receiver,
      amount: f.amount,
      outcome: f.outcome,
    })),
  };
}

function txMatches(actual, t) {
  const e = expectedOf(t);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return (
    actual.signer === e.signer &&
    actual.receiver === e.receiver &&
    same(actual.actions, e.actions) &&
    actual.txStatus === e.txStatus &&
    actual.finality === e.finality &&
    same(actual.ftTransfers, e.ftTransfers)
  );
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * @param {object} evidence the parsed onchain-reverify.json
 * @param {{rpc?: string[], fetch?: typeof fetch, concurrency?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{rows: {check: string, expected: string, actual: string, status: string, link?: string}[], rpcCalls: number}>}
 */
export async function verifyUsdc(evidence, options = {}) {
  const { concurrency = 4 } = options;
  const rpc = createRpc({
    endpoints: options.rpc ?? USDC_RPC,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  const escrow = evidence.escrowAccount.account;
  const token = evidence.getConfig.nep141Token.accountId;
  const rows = [];
  const add = (check, expected, fn, link) =>
    fn().then(
      ({ ok, actual }) => ({ check, expected, actual, status: ok ? PASS : FAIL, ...(link ? { link } : {}) }),
      (e) => ({
        check,
        expected,
        actual: `could not be read: ${e.message}`,
        status: ERROR,
        ...(link ? { link } : {}),
      }),
    );

  // ---- deployment and config (final block) ------------------------------------------------
  rows.push(
    await add(
      "escrow3: deployed code hash equals the M56 evidence",
      evidence.escrowAccount.codeHash,
      async () => {
        const acc = await rpc.viewAccount(escrow);
        return { ok: acc.code_hash === evidence.escrowAccount.codeHash, actual: acc.code_hash };
      },
    ),
  );
  const cfg = evidence.getConfig;
  const cfgText = (c) =>
    `${c.network}, token ${short(c.nep141Token?.accountId ?? "none")} (${c.nep141Token?.decimals} decimals)`;
  rows.push(
    await add("escrow3: get_config network and NEP-141 token", cfgText(cfg), async () => {
      const c = await rpc.callView(escrow, "get_config", {});
      const ok =
        c.network === cfg.network &&
        c.nep141Token?.accountId === token &&
        c.nep141Token?.decimals === cfg.nep141Token.decimals;
      return { ok, actual: cfgText(c) };
    }),
  );
  const rk = evidence.relayerKey;
  const relayer = evidence.setup.find((s) => s.label === "add_relayer_function_call_key")?.signer;
  rows.push(
    await add(
      "escrow3: relayer key is a function-call key whose only receiver is escrow3",
      `FunctionCall key on ${relayer}, receiver ${escrow}`,
      async () => {
        const k = await rpc.viewAccessKey(relayer, rk.publicKey);
        const fc = k.permission?.FunctionCall;
        return {
          ok: fc !== undefined && fc.receiver_id === escrow,
          actual: fc
            ? `FunctionCall key on ${relayer}, receiver ${fc.receiver_id}`
            : `FullAccess key on ${relayer}`,
        };
      },
    ),
  );

  // ---- transactions ------------------------------------------------------------------------
  const all = [
    ...evidence.setup.map((t) => ({ t, group: "setup" })),
    ...evidence.journeys.flatMap((j) => j.transactions.map((t) => ({ t, group: j.kind }))),
  ];
  const read = await pool(all, concurrency, async ({ t }) => {
    try {
      return { s: summariseUsdcTx(await rpc.txStatus(t.txHash, t.signer), escrow, token) };
    } catch (e) {
      return { error: e.message };
    }
  });
  const byHash = new Map(all.map((x, i) => [x.t.txHash, read[i]]));

  for (const t of evidence.setup) {
    const r = byHash.get(t.txHash);
    const e = expectedOf(t);
    rows.push({
      check: `escrow3 ${short(t.txHash)} tx: ${t.label.replace(/_/g, " ")}`,
      expected: describe(e),
      actual: r.error ? `could not be read: ${r.error}` : describe(r.s),
      status: r.error ? ERROR : txMatches(r.s, t) ? PASS : FAIL,
      link: `${TX_LINK}${t.txHash}`,
    });
  }
  for (const j of evidence.journeys) {
    const results = j.transactions.map((t) => ({ t, r: byHash.get(t.txHash) }));
    const unreadable = results.filter((x) => x.r.error);
    const wrong = results.filter((x) => !x.r.error && !txMatches(x.r.s, x.t));
    const payouts = j.transactions.flatMap((t) => expectedOf(t).ftTransfers);
    const paid =
      payouts.length > 0
        ? `; payouts ${payouts.map((f) => `${usdc(f.amount)} to ${f.receiver}`).join(", ")}`
        : "";
    rows.push({
      check: `escrow3 ${j.tradeId.slice(0, 10)}…: ${j.kind} journey, ${j.transactions.length} transactions`,
      expected: `signer, receiver, method, outcome as recorded${paid}`,
      actual:
        unreadable.length > 0
          ? `could not be read: ${unreadable.map((x) => `${short(x.t.txHash)} ${x.r.error}`).join("; ")}`
          : wrong.length > 0
            ? `differs: ${wrong.map((x) => `${x.t.label} ${short(x.t.txHash)}: ${describe(x.r.s)}`).join("; ")}`
            : `all ${j.transactions.length} as recorded${paid}`,
      status: unreadable.length > 0 ? ERROR : wrong.length > 0 ? FAIL : PASS,
    });
  }
  for (const j of evidence.journeys) {
    for (const t of j.transactions.filter((x) => x.expectedRefusal)) {
      const r = byHash.get(t.txHash);
      // A refused funding deposit succeeds and returns the tokens with a `nep141_funding_returned`
      // event carrying the code; every other refusal fails the escrow receipt with that code.
      const viaReturn = t.txStatus === "SuccessValue";
      const expected = viaReturn
        ? `${t.expectedRefusal}, tokens returned in the same transaction`
        : `${t.expectedRefusal} (escrow receipt fails)`;
      let actual;
      let ok = false;
      if (r.error) actual = `could not be read: ${r.error}`;
      else if (viaReturn) {
        ok =
          r.s.txStatus === "SuccessValue" &&
          r.s.logCodes.includes(t.expectedRefusal) &&
          r.s.failedCodes.length === 0;
        actual = r.s.logCodes.length
          ? `${r.s.logCodes.join(", ")}, tokens returned in the same transaction`
          : `no refusal event (${r.s.txStatus})`;
      } else {
        ok =
          r.s.txStatus === "Failure" &&
          r.s.failedCodes.length === 1 &&
          r.s.failedCodes[0] === t.expectedRefusal;
        actual = r.s.failedCodes.length
          ? `${r.s.failedCodes.join(", ")} (escrow receipt fails)`
          : `no refusal (${r.s.txStatus})`;
      }
      rows.push({
        check: `escrow3 ${short(t.txHash)} tx: refused ${t.label.replace(/^refuse:/, "").replace(/_/g, " ")}`,
        expected,
        actual,
        status: r.error ? ERROR : ok ? PASS : FAIL,
        link: `${TX_LINK}${t.txHash}`,
      });
    }
  }

  // ---- ledgers (final block) ---------------------------------------------------------------
  // The token and asset kind are part of the check; the row shows the amounts.
  const totalsText = (l) =>
    TOTALS.filter((k) => l.totals?.[k] !== "0")
      .map((k) => `${k} ${usdc(l.totals[k])}`)
      .join(", ");
  for (const j of evidence.journeys) {
    const want = j.views.ledger;
    rows.push(
      await add(
        `escrow3 ${j.tradeId.slice(0, 10)}… ledger (${j.kind}), conservation recomputed`,
        `${totalsText(want)}, conserved`,
        async () => {
          const l = await rpc.callView(escrow, "get_ledger", { trade_id: j.tradeId });
          const c = checkConservation(l);
          const assetOk = l.asset?.kind === "NEP141" && l.asset?.tokenAccountId === token;
          const totalsOk = TOTALS.every((k) => l.totals?.[k] === want.totals[k]);
          const conserved = c.ok && l.conservation === true;
          const problems = [
            ...(assetOk ? [] : [`asset ${l.asset?.kind} ${l.asset?.tokenAccountId ?? ""}`]),
            ...(conserved
              ? []
              : [`NOT conserved: ${c.problems.join("; ") || `contract flag ${l.conservation}`}`]),
          ];
          return {
            ok: assetOk && totalsOk && conserved,
            actual: `${totalsText(l)}, ${problems.length ? problems.join(", ") : "conserved"}`,
          };
        },
      ),
    );
  }

  // ---- token balances at the evidence block -------------------------------------------------
  const at = evidence.blockHeight;
  const holders = [
    ["supplier", "gnanam1990-dock-supplier.testnet"],
    ["buyer", "gnanam1990-dock-buyer.testnet"],
    ["escrow3", escrow],
  ];
  for (const [role, holder] of holders) {
    const want = evidence.tokenBalances[holder];
    if (want === undefined) continue;
    rows.push(
      await add(`USDC balance of the ${role} at block ${at}`, usdc(want), async () => {
        const b = await rpc.callView(token, "ft_balance_of", { account_id: holder }, at);
        return { ok: b === want, actual: usdc(b) };
      }),
    );
  }
  return { rows, rpcCalls: rpc.calls };
}
