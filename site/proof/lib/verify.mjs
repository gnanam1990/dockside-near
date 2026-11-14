// Verification of a Dockside deployment against the proof manifest, read live from NEAR.
// Used unchanged by the proof page (site/proof/app.mjs) and by `pnpm judge` (scripts/judge).
//
// Every row compares an EXPECTED value (from site/proof/proof-manifest.json, which is generated
// from the committed run records under docs/evidence/) with the ACTUAL value read from the chain
// in this run. Nothing is cached and nothing is assumed: a value that cannot be read is an ERROR
// row, never a pass.
import { base58Encode, base64ToBytes, createRpc, hexToBytes, sha256Hex } from "./near-rpc.mjs";

export const PASS = "PASS";
export const FAIL = "FAIL";
export const ERROR = "ERROR";

const BUCKETS = [
  "partial",
  "available",
  "reserved",
  "released",
  "refundLocked",
  "refunded",
  "quarantined",
  "fees",
];
const YOCTO = 10n ** 24n;

/** "50000000000000000000000" -> "0.05 NEAR". Exact: no rounding, no floating point. */
export function formatNear(yocto) {
  const n = BigInt(yocto);
  const whole = n / YOCTO;
  const frac = (n % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
}

/**
 * An amount for people, in the unit of the trade's asset as the contract reports it (get_ledger's
 * `asset`): NEAR exactly for NEAR_NATIVE; for NEP141 the token's base units shifted by its
 * decimals, with at least two decimal places ("2000000" at 6 decimals is "2.00"). Exact: no
 * rounding, no floating point. An asset this code does not know keeps its base units.
 */
export function formatUnits(amount, asset) {
  const n = BigInt(amount);
  if (asset?.kind === "NEAR_NATIVE") return formatNear(n).replace(/ NEAR$/, "");
  if (!isToken(asset)) return n.toString();
  const scale = 10n ** BigInt(asset.decimals);
  const frac = (n % scale).toString().padStart(asset.decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${n / scale}.${frac}`;
}

/** The unit an amount of this asset is stated in: "NEAR", the token's symbol, or its account. */
export function assetUnit(asset, symbol = null) {
  if (asset?.kind === "NEAR_NATIVE") return "NEAR";
  if (isToken(asset)) return symbol ?? `tokens of ${asset.tokenAccountId}`;
  return "base units";
}

/** "2000000" of a 6-decimal token whose symbol is USDC -> "2.00 USDC"; NEAR as formatNear does. */
export function formatAmount(amount, asset, symbol = null) {
  return `${formatUnits(amount, asset)} ${assetUnit(asset, symbol)}`;
}

/** The symbol a token's ft_metadata names, only when it is a short plain name; otherwise null. */
export function tokenSymbol(meta) {
  const s = meta?.symbol;
  return typeof s === "string" && /^[A-Za-z0-9.$_-]{1,16}$/.test(s) ? s : null;
}

function isToken(asset) {
  return (
    asset?.kind === "NEP141" &&
    typeof asset.tokenAccountId === "string" &&
    Number.isInteger(asset.decimals) &&
    asset.decimals >= 0 &&
    asset.decimals <= 36
  );
}

/** The base-unit name shown next to an exact amount: yocto for NEAR, base units otherwise. */
const baseUnits = (asset) => (asset?.kind === "NEAR_NATIVE" ? "yocto" : "base units");

const big = (v) => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`not an amount: ${JSON.stringify(v)}`);
  return BigInt(v);
};

/**
 * Recomputes the escrow's conservation invariant from a `get_ledger` answer, independently of the
 * `conservation` flag the contract reports. Same rules as `Ledger::check_conservation`:
 * every funder's buckets sum to what that funder funded, the deposits sum to the funded total,
 * the totals row is the sum of the funders, and committed value never exceeds the trade amount.
 */
export function checkConservation(ledger) {
  const problems = [];
  const sums = Object.fromEntries(BUCKETS.map((b) => [b, 0n]));
  let funded = 0n;
  try {
    for (const [account, f] of Object.entries(ledger.funders ?? {})) {
      let s = 0n;
      for (const b of BUCKETS) {
        s += big(f[b]);
        sums[b] += big(f[b]);
      }
      if (s !== big(f.funded)) problems.push(`buckets of ${account} sum to ${s}, funded ${f.funded}`);
      funded += big(f.funded);
    }
    const deposits = (ledger.deposits ?? []).reduce((a, d) => a + big(d.amount), 0n);
    if (deposits !== funded) problems.push(`deposits sum to ${deposits}, funders funded ${funded}`);
    if (big(ledger.totals.funded) !== funded) {
      problems.push(`totals.funded ${ledger.totals.funded}, funders funded ${funded}`);
    }
    for (const b of BUCKETS) {
      if (big(ledger.totals[b]) !== sums[b]) {
        problems.push(`totals.${b} ${ledger.totals[b]}, funders ${sums[b]}`);
      }
    }
    const committed = sums.partial + sums.available + sums.reserved + sums.released;
    if (big(ledger.committed) !== committed) {
      problems.push(`committed ${ledger.committed}, buckets say ${committed}`);
    }
    if (committed > big(ledger.required)) {
      problems.push(`committed ${committed} exceeds required ${ledger.required}`);
    }
    const parts = BUCKETS.filter((b) => sums[b] > 0n).map((b) => `${b} ${sums[b]}`);
    const equation = `funded ${funded} = ${parts.length > 0 ? parts.join(" + ") : "0"}`;
    return { ok: problems.length === 0, problems, funded: funded.toString(), equation };
  } catch (e) {
    return { ok: false, problems: [`malformed ledger: ${e.message}`], funded: null, equation: "" };
  }
}

/** What one transaction did, reduced to the facts the proof needs. */
export function summariseTx(result, contractId) {
  const tx = result.transaction ?? {};
  const actions = (tx.actions ?? []).map((a) =>
    typeof a === "string"
      ? a
      : a.FunctionCall
        ? `FunctionCall:${a.FunctionCall.method_name}`
        : Object.keys(a)[0],
  );
  const status = result.status ?? {};
  const outcomes = new Map((result.receipts_outcome ?? []).map((o) => [o.id, o.outcome?.status ?? {}]));
  const failedReceipts = [...outcomes.values()].filter((s) => "Failure" in s).length;
  const transfers = [];
  for (const r of result.receipts ?? []) {
    if (r.predecessor_id !== contractId || r.receiver_id === contractId) continue;
    for (const a of r.receipt?.Action?.actions ?? []) {
      if (!a.Transfer) continue;
      const st = outcomes.get(r.receipt_id);
      transfers.push({
        to: r.receiver_id,
        amount: a.Transfer.deposit,
        succeeded: st !== undefined && ("SuccessValue" in st || "SuccessReceiptId" in st),
      });
    }
  }
  return {
    signer: tx.signer_id,
    receiver: tx.receiver_id,
    actions,
    success: "SuccessValue" in status || "SuccessReceiptId" in status,
    finality: result.final_execution_status,
    failedReceipts,
    transfers,
  };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const link = (template, key, value) => (template ? template.replace(`{${key}}`, value) : undefined);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const transferKey = (t) => `${t.to} ${t.amount.padStart(40, "0")}`;
const sortTransfers = (list) =>
  [...list]
    .map((t) => ({ to: t.to, amount: t.amount }))
    .sort((a, b) => (transferKey(a) < transferKey(b) ? -1 : 1));
const showTransfers = (list, fmt = formatNear) =>
  list.length === 0
    ? "no transfer"
    : sortTransfers(list)
        .map((t) => `${fmt(t.amount)} to ${t.to}`)
        .join("; ");

function describeTx(s) {
  const what = s.actions.map((a) => a.replace(/^FunctionCall:/, "")).join(" + ") || "no action";
  const where = s.receiver === s.signer ? "itself" : s.receiver;
  const how = s.success ? "success" : "FAILED";
  const failed = s.failedReceipts > 0 ? `, ${s.failedReceipts} failed receipt(s)` : "";
  return `${what} by ${s.signer} on ${where}, ${how}, ${s.finality}${failed}`;
}

function showRefunds(list, fmt) {
  return [...list]
    .sort((a, b) => (a.refundIntentId < b.refundIntentId ? -1 : 1))
    .map((r) => `${r.reason} ${fmt(r.amount)} ${r.state}`)
    .join("; ");
}

export function summarise(rows) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { total: rows.length, pass: count(PASS), fail: count(FAIL), error: count(ERROR) };
}

/** PASS only when there is at least one row and every row passed. */
export function verdict(result) {
  if (result.state === "NOT_DEPLOYED") return "NOT_DEPLOYED";
  const s = result.summary;
  return s.total > 0 && s.pass === s.total ? PASS : FAIL;
}

/**
 * Verifies one network of the manifest. Returns `state: "NOT_DEPLOYED"` without a single RPC call
 * when the manifest has no deployment for it.
 *
 * @param {object} network one entry of manifest.networks
 * @param {{fetch?: typeof fetch, downloadCode?: boolean, concurrency?: number, timeoutMs?: number}} [options]
 */
export async function verifyNetwork(network, options = {}) {
  const { downloadCode = true, concurrency = 4 } = options;
  const rows = [];
  const row = (r) => {
    rows.push(r);
    return r;
  };
  const done = (extra) => ({ rows, summary: summarise(rows), ...extra });
  const d = network.deployment;
  if (!d) return done({ state: "NOT_DEPLOYED", block: null, config: null, trades: [], rpcCalls: 0 });

  const rpc = createRpc({ endpoints: network.rpc, fetch: options.fetch, timeoutMs: options.timeoutMs });
  const ex = network.explorer ?? {};

  /** Runs one check; a thrown error (RPC unreachable, malformed answer) becomes an ERROR row. */
  async function check(base, fn) {
    try {
      const r = await fn();
      const { ok, ...rest } = r;
      return row({ ...base, ...rest, status: ok ? PASS : FAIL });
    } catch (e) {
      return row({ ...base, actual: `could not be read: ${e.message}`, status: ERROR });
    }
  }

  let block = null;
  try {
    block = await rpc.finalBlock();
  } catch (e) {
    row({
      id: "block",
      group: "deployment",
      title: "Final block",
      expected: "a final block from the RPC endpoint",
      actual: `could not be read: ${e.message}`,
      status: ERROR,
    });
    return done({ state: "CHECKED", block, config: null, trades: [], rpcCalls: rpc.calls });
  }
  const at = block.height;

  // ---- deployment -------------------------------------------------------------------------
  const art = d.artifact;
  await check(
    {
      id: "code-hash",
      group: "deployment",
      title: "Deployed code hash equals the build manifest",
      expected: art.nearCodeHash,
      link: link(ex.account, "account", d.contractId),
    },
    async () => {
      const acc = await rpc.viewAccount(d.contractId, at);
      return { ok: acc.code_hash === art.nearCodeHash, actual: acc.code_hash };
    },
  );
  await check(
    {
      id: "artifact-digest",
      group: "deployment",
      title: "Manifest SHA-256 and NEAR code hash are the same digest",
      expected: art.nearCodeHash,
      detail: `sha256 ${art.sha256}, built from commit ${art.commit}`,
    },
    async () => {
      const b58 = base58Encode(hexToBytes(art.sha256));
      return { ok: b58 === art.nearCodeHash, actual: b58 };
    },
  );
  if (downloadCode) {
    await check(
      {
        id: "code-bytes",
        group: "deployment",
        title: "Contract bytes downloaded from the chain hash to the manifest SHA-256",
        expected: `${art.bytes} bytes, sha256 ${art.sha256}`,
      },
      async () => {
        const code = base64ToBytes((await rpc.viewCode(d.contractId, at)).code_base64);
        const digest = await sha256Hex(code);
        return {
          ok: digest === art.sha256 && code.length === art.bytes,
          actual: `${code.length} bytes, sha256 ${digest}`,
        };
      },
    );
  }
  if (d.deployTx) {
    await check(
      {
        id: "deploy-tx",
        group: "deployment",
        title: "Deployment transaction",
        expected: `DeployContract + new by ${d.deployTx.signer} on itself, success, FINAL`,
        link: link(ex.tx, "hash", d.deployTx.hash),
        txHash: d.deployTx.hash,
      },
      async () => {
        const s = summariseTx(await rpc.txStatus(d.deployTx.hash, d.deployTx.signer), d.contractId);
        const ok =
          s.signer === d.deployTx.signer &&
          s.receiver === d.contractId &&
          same(s.actions, ["DeployContract", "FunctionCall:new"]) &&
          s.success &&
          s.finality === "FINAL" &&
          s.failedReceipts === 0;
        return { ok, actual: describeTx(s) };
      },
    );
  }
  if (d.relayer) {
    await check(
      {
        id: "relayer-key",
        group: "deployment",
        title: "Relayer key is a function-call key limited to the escrow (it cannot transfer funds)",
        expected: `FunctionCall key on ${d.relayer.account}, receiver ${d.contractId}`,
        detail: d.relayer.publicKey,
        link: link(ex.account, "account", d.relayer.account),
      },
      async () => {
        const k = await rpc.viewAccessKey(d.relayer.account, d.relayer.publicKey, at);
        const fc = k.permission?.FunctionCall;
        return {
          ok: fc !== undefined && fc.receiver_id === d.contractId,
          actual: fc
            ? `FunctionCall key on ${d.relayer.account}, receiver ${fc.receiver_id}`
            : `FullAccess key on ${d.relayer.account}`,
        };
      },
    );
  }

  // ---- config -----------------------------------------------------------------------------
  let config = null;
  try {
    config = await rpc.callView(d.contractId, "get_config", {}, at);
  } catch (e) {
    row({
      id: "config",
      group: "config",
      title: "get_config",
      expected: JSON.stringify(d.config),
      actual: `could not be read: ${e.message}`,
      status: ERROR,
    });
  }
  if (config) {
    const cfg = (id, title, expected, actual, ok) =>
      row({ id, group: "config", title, expected, actual, status: ok ? PASS : FAIL });
    cfg(
      "config-network",
      "Contract network",
      d.config.network,
      String(config.network),
      config.network === d.config.network,
    );
    cfg(
      "config-min-deposit",
      "Minimum deposit",
      `${d.config.minDepositYocto} yoctoNEAR`,
      `${config.minDepositYocto} yoctoNEAR`,
      config.minDepositYocto === d.config.minDepositYocto,
    );
    cfg(
      "config-refund-policy",
      "Refund policy",
      JSON.stringify(d.config.refundPolicy),
      JSON.stringify(config.refundPolicy),
      same(config.refundPolicy, d.config.refundPolicy),
    );
    cfg(
      "config-trades",
      "Trades registered on the contract",
      `at least ${network.journeys.length} (one per journey below)`,
      String(config.trades),
      Number.isInteger(config.trades) && config.trades >= network.journeys.length,
    );
  }

  // ---- transactions (read first: the trade checks cross-check their receipts) ---------------
  const txJobs = network.journeys.flatMap((j) => j.transactions.map((t, i) => ({ j, t, i })));
  const txSummaries = new Map();
  const txRows = await pool(txJobs, concurrency, async ({ j, t, i }) => {
    const base = {
      id: `tx:${t.txHash}`,
      group: `tx:${j.tradeId}`,
      title: `${i + 1}. ${t.method}${t.step && t.step !== t.method ? ` (${t.step})` : ""}`,
      expected: `${t.method} by ${t.signer} on ${d.contractId}, success, FINAL`,
      link: link(ex.tx, "hash", t.txHash),
      txHash: t.txHash,
    };
    try {
      const s = summariseTx(await rpc.txStatus(t.txHash, t.signer), d.contractId);
      txSummaries.set(t.txHash, s);
      const ok =
        s.signer === t.signer &&
        s.receiver === d.contractId &&
        same(s.actions, [`FunctionCall:${t.method}`]) &&
        s.success &&
        s.finality === "FINAL" &&
        s.failedReceipts === 0;
      return { ...base, actual: describeTx(s), status: ok ? PASS : FAIL };
    } catch (e) {
      return { ...base, actual: `could not be read: ${e.message}`, status: ERROR };
    }
  });

  // ---- trades -----------------------------------------------------------------------------
  const trades = [];
  for (const j of network.journeys) {
    const group = `trade:${j.tradeId}`;
    const exp = j.expected;
    const view = {
      tradeId: j.tradeId,
      kind: j.kind,
      evidence: j.evidence,
      ledger: null,
      trade: null,
      asset: null,
      symbol: null,
    };
    // Amounts are stated in the trade's asset once get_ledger has named it.
    const fmt = (v) => formatAmount(v, view.asset, view.symbol);
    trades.push(view);
    const call = (method) => rpc.callView(d.contractId, method, { trade_id: j.tradeId }, at);
    let ledger = null;
    let release = null;
    let refunds = null;
    await check(
      {
        id: `${j.tradeId}:registered`,
        group,
        title: "Trade is registered on this contract",
        expected: `${j.tradeId} on ${d.config.network}`,
      },
      async () => {
        const t = await call("get_trade");
        view.trade = {
          buyerAccount: t.buyerAccount,
          supplierAccount: t.supplierAccount,
          payoutDestination: t.payoutDestination,
          amountYocto: t.amountYocto,
          termsDigest: t.termsDigest,
        };
        return {
          ok: t.tradeId === j.tradeId && t.network === d.config.network,
          actual: `${t.tradeId} on ${t.network}`,
        };
      },
    );
    await check(
      {
        id: `${j.tradeId}:conservation`,
        group,
        title: "Ledger conservation, recomputed here from get_ledger",
        expected: "funder buckets sum to funded; deposits sum to funded; committed within the trade amount",
      },
      async () => {
        ledger = await call("get_ledger");
        view.ledger = ledger;
        view.asset = ledger?.asset ?? null;
        if (view.asset?.kind === "NEP141" && typeof view.asset.tokenAccountId === "string") {
          try {
            view.symbol = tokenSymbol(await rpc.callView(view.asset.tokenAccountId, "ft_metadata", {}, at));
          } catch {
            view.symbol = null; // unreadable metadata: the token is named by its account instead
          }
        }
        const c = checkConservation(ledger);
        return { ok: c.ok, actual: c.ok ? c.equation : c.problems.join("; ") };
      },
    );
    if (ledger) {
      row({
        id: `${j.tradeId}:conservation-flag`,
        group,
        title: "Contract's own conservation check",
        expected: "true",
        actual: String(ledger.conservation),
        status: ledger.conservation === true ? PASS : FAIL,
      });
      const t = ledger.totals;
      const amount = (id, title, want, got) =>
        row({
          id: `${j.tradeId}:${id}`,
          group,
          title,
          expected: `${fmt(want)} (${want} ${baseUnits(view.asset)})`,
          actual: `${fmt(got)} (${got} ${baseUnits(view.asset)})`,
          status: want === got ? PASS : FAIL,
        });
      try {
        if (exp.funded !== undefined) amount("funded", "Funded in total", exp.funded, t.funded);
        amount("released", "Released to the supplier", exp.released, t.released);
        amount("refunded", "Refunded to the funder", exp.refunded, t.refunded);
        const left = ["partial", "available", "reserved", "refundLocked", "quarantined"].reduce(
          (a, b) => a + big(t[b]),
          0n,
        );
        amount("held", "Value still held for this trade", "0", left.toString());
      } catch (e) {
        row({
          id: `${j.tradeId}:amounts`,
          group,
          title: "Ledger totals",
          expected: "amounts as decimal strings",
          actual: `could not be read: ${e.message}`,
          status: ERROR,
        });
      }
    }
    if (exp.release) {
      await check(
        {
          id: `${j.tradeId}:release-intent`,
          group,
          title: "Release intent state",
          expected: `${exp.release.intentId} PAID, ${fmt(exp.release.amount)}`,
        },
        async () => {
          release = await call("get_release");
          const it = (release.intents ?? []).find((x) => x.releaseIntentId === exp.release.intentId);
          if (!it) return { ok: false, actual: "intent not found" };
          return {
            ok: it.state === "PAID" && it.amount === exp.release.amount,
            actual: `${it.releaseIntentId} ${it.state}, ${fmt(it.amount)}`,
          };
        },
      );
    }
    if (exp.hold) {
      await check(
        {
          id: `${j.tradeId}:hold`,
          group,
          title: "Hold set by the deterministic policy and resolved before the release",
          expected: `RESOLVED, issuer ${exp.hold.issuerRole}, rule ${exp.hold.ruleId}`,
        },
        async () => {
          const holds = await call("get_holds");
          const h = (holds ?? []).find(
            (x) => x.issuerRole === exp.hold.issuerRole && x.ruleId === exp.hold.ruleId,
          );
          if (!h) return { ok: false, actual: "no such hold" };
          return {
            ok: h.status === "RESOLVED",
            actual: `${h.status}, issuer ${h.issuerRole}, rule ${h.ruleId}`,
            detail: `${h.holdId}, reason ${h.reasonCode}, resolution ${h.resolution?.code ?? "none"}`,
          };
        },
      );
    }
    if (exp.refunds.length > 0) {
      await check(
        {
          id: `${j.tradeId}:refund-intents`,
          group,
          title: "Refund intents",
          expected: showRefunds(
            exp.refunds.map((r) => ({ ...r, state: "REFUNDED" })),
            fmt,
          ),
        },
        async () => {
          refunds = await call("get_refunds");
          const got = exp.refunds.map((r) =>
            (refunds ?? []).find((x) => x.refundIntentId === r.refundIntentId),
          );
          if (got.some((x) => !x)) return { ok: false, actual: "refund intent not found" };
          const ok = got.every(
            (x, i) =>
              x.state === "REFUNDED" &&
              x.reason === exp.refunds[i].reason &&
              x.amount === exp.refunds[i].amount,
          );
          return { ok, actual: showRefunds(got, fmt) };
        },
      );
    }
    // Cross-check of two independent chain sources: what the contract's views say was paid out,
    // against the Transfer receipts the escrow account emitted in this trade's transactions.
    await check(
      {
        id: `${j.tradeId}:transfers`,
        group,
        title: "Transfers out of the escrow equal what the contract recorded as paid",
        expected: "the PAID release intents and REFUNDED refund intents of this trade",
      },
      async () => {
        release ??= await call("get_release");
        refunds ??= await call("get_refunds");
        const want = [];
        for (const it of release.intents ?? []) {
          if (it.state === "PAID") want.push({ to: it.destination, amount: it.amount });
        }
        for (const r of refunds ?? []) {
          if (r.state === "REFUNDED") want.push({ to: r.funder, amount: r.amount });
        }
        const got = [];
        for (const t of j.transactions) {
          const s = txSummaries.get(t.txHash);
          if (!s) throw new Error(`transaction ${t.txHash} was not read`);
          for (const x of s.transfers) {
            if (!x.succeeded) throw new Error(`a transfer receipt of ${t.txHash} did not succeed`);
            got.push(x);
          }
        }
        return {
          ok: same(sortTransfers(want), sortTransfers(got)),
          expected: showTransfers(want, fmt),
          // Transfer receipts move NEAR itself, whatever the trade's asset.
          actual: showTransfers(got),
        };
      },
    );
  }
  for (const r of txRows) row(r);

  return done({ state: "CHECKED", block, config, trades, rpcCalls: rpc.calls });
}
