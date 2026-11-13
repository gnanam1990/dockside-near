// Verification of one Dockside payment receipt, read live from NEAR by the reader's browser.
// Used by the receipt page (site/proof/receipt.mjs) and the offline regression suites.
//
// A receipt is not a document we ask anyone to trust. Every fact it shows (parties, amount, asset,
// inspection result, the release and the transaction that paid it) is read here from the escrow
// contract at one final block, and checked: the contract runs the audited build named in the proof
// manifest, the ledger still conserves value, the release was approved on this inspection, and the
// release transaction is final, succeeded and moved exactly the released amount to the payee.
// A value that cannot be read is an ERROR row, never a pass.
import { createRpc } from "./near-rpc.mjs";
import { checkConservation, ERROR, FAIL, formatNear, PASS, summarise, summariseTx } from "./verify.mjs";

const TRADE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const NETWORKS = new Set(["testnet", "mainnet"]);

const link = (template, key, value) => (template ? template.replace(`{${key}}`, value) : undefined);
const big = (v) => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`not an amount: ${JSON.stringify(v)}`);
  return BigInt(v);
};

function decodeArgs(b64) {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** Human text for the trade asset as the contract reports it. */
export function assetText(asset) {
  if (asset?.kind === "NEAR_NATIVE") return "NEAR (native)";
  if (asset?.kind === "NEP141") return `NEP-141 token ${asset.tokenAccountId}`;
  return `unknown asset ${JSON.stringify(asset)}`;
}

function amountText(asset, amount) {
  if (asset?.kind === "NEAR_NATIVE") return formatNear(amount);
  if (asset?.kind === "NEP141" && Number.isInteger(asset.decimals))
    return `${tokenUnits(amount, asset.decimals)} (${amount} base units of ${asset.tokenAccountId})`;
  return `${amount} base units`;
}

/** `5000000` at 6 decimals is `5`: base units of a token for people. */
function tokenUnits(amount, decimals) {
  const s = String(amount).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The NEP-141 transfers the escrow sent in one transaction: each `ft_transfer` receipt from the
 * escrow to the token contract, with the receiver and amount it names and whether it succeeded
 * (a failed `ft_transfer` is reverted by the token contract).
 */
function tokenTransfers(result, contractId, tokenId) {
  const outcomes = new Map((result.receipts_outcome ?? []).map((o) => [o.id, o.outcome?.status ?? {}]));
  const out = [];
  for (const r of result.receipts ?? []) {
    if (r.predecessor_id !== contractId || r.receiver_id !== tokenId) continue;
    for (const a of r.receipt?.Action?.actions ?? []) {
      const fc = a?.FunctionCall;
      if (!fc || fc.method_name !== "ft_transfer") continue;
      const args = decodeArgs(fc.args);
      const st = outcomes.get(r.receipt_id);
      out.push({
        to: typeof args?.receiver_id === "string" ? args.receiver_id : null,
        amount: typeof args?.amount === "string" ? args.amount : null,
        deposit: fc.deposit,
        succeeded: st !== undefined && ("SuccessValue" in st || "SuccessReceiptId" in st),
      });
    }
  }
  return out;
}

/**
 * The receipt a page address names: `/receipt/<trade id>` (hosted app) or
 * `receipt.html?trade=<trade id>` (static proof site), with optional `network`, `tx` and `signer`.
 * Returns null for an address that names no valid receipt.
 */
export function parseReceiptLocation(href) {
  const url = new URL(href);
  const fromPath = /\/receipt\/([^/]+)$/.exec(url.pathname)?.[1];
  let tradeId;
  try {
    tradeId = fromPath !== undefined ? decodeURIComponent(fromPath) : url.searchParams.get("trade");
  } catch {
    return null;
  }
  if (!tradeId || !TRADE_ID.test(tradeId)) return null;
  const network = url.searchParams.get("network") ?? "testnet";
  if (!NETWORKS.has(network)) return null;
  const out = { tradeId, network };
  const tx = url.searchParams.get("tx");
  const signer = url.searchParams.get("signer");
  if (tx !== null) {
    if (!TX_HASH.test(tx)) return null;
    out.txHash = tx;
  }
  if (signer !== null) {
    if (!ACCOUNT.test(signer)) return null;
    out.signer = signer;
  }
  return out;
}

/** The address the QR code on a receipt carries. */
export function receiptLink(origin, { tradeId, network = "testnet", txHash, signer }) {
  const url = new URL(`/receipt/${encodeURIComponent(tradeId)}`, origin);
  url.searchParams.set("network", network);
  if (txHash) url.searchParams.set("tx", txHash);
  if (signer) url.searchParams.set("signer", signer);
  return url.toString();
}

/** PASS only when there is at least one row and every row passed. */
export function receiptVerdict(result) {
  if (result.state === "NOT_DEPLOYED") return "NOT_DEPLOYED";
  const s = result.summary;
  return s.total > 0 && s.pass === s.total ? PASS : FAIL;
}

/** The release transaction to check: the one the link names, else the one the manifest lists. */
function releaseTxFor(network, subject) {
  const d = network.deployment;
  if (subject.txHash) {
    return { hash: subject.txHash, signer: subject.signer ?? d.relayer?.account ?? null, source: "link" };
  }
  const j = (network.journeys ?? []).find((x) => x.tradeId === subject.tradeId);
  const t = j?.transactions.filter((x) => x.method === "execute_release").at(-1);
  return t ? { hash: t.txHash, signer: t.signer, source: "manifest" } : null;
}

/**
 * @param {object} network one entry of proof-manifest.json `networks`
 * @param {{tradeId: string, txHash?: string, signer?: string}} subject
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} [options]
 */
export async function verifyReceipt(network, subject, options = {}) {
  if (typeof subject?.tradeId !== "string" || !TRADE_ID.test(subject.tradeId))
    throw new Error("not a valid trade id");
  if (subject.txHash !== undefined && !TX_HASH.test(subject.txHash))
    throw new Error("not a valid transaction hash");
  if (subject.signer !== undefined && !ACCOUNT.test(subject.signer))
    throw new Error("not a valid signer account");

  const rows = [];
  const row = (r) => rows.push(r);
  const d = network.deployment;
  const done = (extra) => ({ rows, summary: summarise(rows), ...extra });
  if (!d) return done({ state: "NOT_DEPLOYED", block: null, facts: null, rpcCalls: 0 });

  const rpc = createRpc({ endpoints: network.rpc, fetch: options.fetch, timeoutMs: options.timeoutMs });
  const ex = network.explorer ?? {};
  const tradeId = subject.tradeId;
  const facts = { tradeId, network: d.config.network, contractId: d.contractId };
  const finish = (block) => done({ state: "CHECKED", block, facts, rpcCalls: rpc.calls });

  async function check(base, fn) {
    try {
      const { ok, ...rest } = await fn();
      row({ ...base, ...rest, status: ok ? PASS : FAIL });
      return ok;
    } catch (e) {
      row({ ...base, actual: `could not be read: ${e.message}`, status: ERROR });
      return null;
    }
  }

  let block;
  try {
    block = await rpc.finalBlock();
  } catch (e) {
    row({
      id: "block",
      title: "Final block",
      expected: "a final block from the RPC endpoint",
      actual: `could not be read: ${e.message}`,
      status: ERROR,
    });
    return finish(null);
  }
  const at = block.height;
  const call = (method) => rpc.callView(d.contractId, method, { trade_id: tradeId }, at);

  // 1. The escrow runs the audited build.
  await check(
    {
      id: "code-hash",
      title: "The escrow runs the audited build named in the proof manifest",
      expected: d.artifact.nearCodeHash,
      link: link(ex.account, "account", d.contractId),
    },
    async () => {
      const acc = await rpc.viewAccount(d.contractId, at);
      facts.codeHash = acc.code_hash;
      return { ok: acc.code_hash === d.artifact.nearCodeHash, actual: acc.code_hash };
    },
  );

  // 2. The trade and its parties, as the contract registered them.
  let trade = null;
  await check(
    {
      id: "trade",
      title: "The trade is registered on this escrow",
      expected: `${tradeId} on ${d.config.network}`,
    },
    async () => {
      trade = await call("get_trade");
      Object.assign(facts, {
        buyer: trade.buyerAccount,
        supplier: trade.supplierAccount,
        payoutDestination: trade.payoutDestination,
        termsDigest: trade.termsDigest,
        tradeAmount: trade.amountYocto,
      });
      return {
        ok: trade.tradeId === tradeId && trade.network === d.config.network,
        actual: `${trade.tradeId} on ${trade.network}`,
      };
    },
  );
  if (!trade) return finish(block);

  let ledger = null;
  let evidence = null;
  let release = null;
  try {
    [ledger, evidence, release] = await Promise.all([
      call("get_ledger"),
      call("get_evidence"),
      call("get_release"),
    ]);
  } catch (e) {
    row({
      id: "views",
      title: "Ledger, evidence and release views",
      expected: "readable at the same final block",
      actual: `could not be read: ${e.message}`,
      status: ERROR,
    });
    return finish(block);
  }
  facts.asset = ledger.asset;
  facts.assetText = assetText(ledger.asset);

  // 3. The inspection result the release relied on.
  const ins = evidence?.inspection ?? null;
  facts.inspection = ins
    ? {
        decision: ins.decision,
        reasonCodes: ins.reasonCodes ?? [],
        digest: ins.digest,
        recordedAt: ins.recordedAt,
      }
    : null;
  row({
    id: "inspection",
    title: "Inspection result recorded on the contract",
    expected: "PASS",
    actual: ins
      ? `${ins.decision} (${(ins.reasonCodes ?? []).join(", ") || "no reason code"})`
      : "no inspection",
    detail: ins ? `inspection digest ${ins.digest}` : undefined,
    status: ins && ins.decision === "PASS" && ins.invalidated !== true ? PASS : FAIL,
  });

  // 4. The paid release intent.
  const paid = (release?.intents ?? []).filter((x) => x.state === "PAID");
  const intent = paid.at(-1) ?? null;
  if (intent) {
    const paidAt = (intent.history ?? []).find((h) => h[0] === "PAID")?.[1] ?? null;
    facts.release = {
      intentId: intent.releaseIntentId,
      state: intent.state,
      amount: intent.amount,
      destination: intent.destination,
      approvedAt: intent.approval?.approvedAt ?? null,
      paidAt,
    };
    facts.amount = intent.amount;
    facts.amountText = amountText(ledger.asset, intent.amount);
  }
  row({
    id: "release-intent",
    title: "A release intent of this trade is PAID",
    expected: "PAID",
    actual: intent
      ? `${intent.releaseIntentId} PAID, ${amountText(ledger.asset, intent.amount)} to ${intent.destination}`
      : "no PAID release intent",
    status: intent ? PASS : FAIL,
  });

  // 5. The release was approved on this manifest and this inspection.
  {
    const a = intent?.approval ?? null;
    const ok =
      a !== null &&
      ins !== null &&
      a.inspectionDigest === ins.digest &&
      a.manifestDigest === ins.manifestDigest &&
      a.manifestDigest === (evidence?.current?.digest ?? null);
    row({
      id: "approval-binding",
      title: "The release approval names this inspection and this evidence manifest",
      expected: ins ? `inspection ${ins.digest}` : "an inspection",
      actual: a ? `inspection ${a.inspectionDigest}, manifest ${a.manifestDigest}` : "no approval",
      status: ok ? PASS : FAIL,
    });
  }

  // 6. Conservation, recomputed here.
  {
    const c = checkConservation(ledger);
    row({
      id: "conservation",
      title: "Ledger conservation, recomputed here from get_ledger",
      expected: "funder buckets sum to funded; deposits sum to funded; committed within the trade amount",
      actual: c.ok ? c.equation : c.problems.join("; "),
      status: c.ok && ledger.conservation === true ? PASS : FAIL,
    });
  }

  // 7. The ledger shows exactly the paid intents as released.
  try {
    const want = paid.reduce((s, x) => s + big(x.amount), 0n);
    const got = big(ledger.totals?.released);
    row({
      id: "released-total",
      title: "The ledger's released total equals the paid release intents",
      expected: amountText(ledger.asset, want.toString()),
      actual: amountText(ledger.asset, got.toString()),
      status: want === got && want > 0n ? PASS : FAIL,
    });
  } catch (e) {
    row({
      id: "released-total",
      title: "The ledger's released total equals the paid release intents",
      expected: "amounts as decimal strings",
      actual: `could not be read: ${e.message}`,
      status: ERROR,
    });
  }

  // 8 and 9. The release transaction and the transfer it made.
  const tx = releaseTxFor(network, subject);
  const txBase = {
    id: "release-tx",
    title: "Release transaction: execute_release of this trade, final and successful",
    expected: intent
      ? `execute_release of ${tradeId} / ${intent.releaseIntentId} on ${d.contractId}, success, FINAL`
      : `execute_release of ${tradeId} on ${d.contractId}, success, FINAL`,
  };
  const transferBase = {
    id: "release-transfer",
    title: "The escrow transferred the released amount to the payee in that transaction",
    expected: intent
      ? `${amountText(ledger.asset, intent.amount)} to ${intent.destination}`
      : "a paid release",
  };
  if (!tx?.signer) {
    const why = "no release transaction named: open the receipt link with its tx parameter";
    row({ ...txBase, actual: why, status: ERROR });
    row({ ...transferBase, actual: why, status: ERROR });
    return finish(block);
  }
  facts.tx = { hash: tx.hash, signer: tx.signer, source: tx.source, link: link(ex.tx, "hash", tx.hash) };
  txBase.link = facts.tx.link;
  txBase.txHash = tx.hash;
  let result;
  try {
    result = await rpc.txStatus(tx.hash, tx.signer);
  } catch (e) {
    row({ ...txBase, actual: `could not be read: ${e.message}`, status: ERROR });
    row({ ...transferBase, actual: "the release transaction could not be read", status: ERROR });
    return finish(block);
  }
  const s = summariseTx(result, d.contractId);
  const fc = (result.transaction?.actions ?? [])[0]?.FunctionCall;
  const args = fc ? decodeArgs(fc.args) : null;
  const named = args ? `${args.trade_id} / ${args.release_intent_id}` : "unreadable arguments";
  const callOk =
    s.receiver === d.contractId &&
    s.actions.length === 1 &&
    s.actions[0] === "FunctionCall:execute_release" &&
    args?.trade_id === tradeId &&
    intent !== null &&
    args?.release_intent_id === intent.releaseIntentId;
  row({
    ...txBase,
    actual: `${s.actions.map((a) => a.replace(/^FunctionCall:/, "")).join(" + ") || "no action"} of ${named} by ${s.signer} on ${s.receiver}, ${s.success ? "success" : "FAILED"}, ${s.finality}${s.failedReceipts ? `, ${s.failedReceipts} failed receipt(s)` : ""}`,
    status: callOk && s.success && s.finality === "FINAL" && s.failedReceipts === 0 ? PASS : FAIL,
  });

  if (ledger.asset?.kind === "NEP141" && typeof ledger.asset.tokenAccountId === "string") {
    // A token trade is paid by the escrow's `ft_transfer` on the token contract, one yoctoNEAR
    // attached; no native transfer leaves the escrow.
    const sent = tokenTransfers(result, d.contractId, ledger.asset.tokenAccountId);
    const shown =
      sent.length === 0
        ? `no ft_transfer from the escrow on ${ledger.asset.tokenAccountId}`
        : sent
            .map(
              (t) =>
                `ft_transfer of ${t.amount === null ? "an unreadable amount" : amountText(ledger.asset, t.amount)} to ${t.to ?? "an unreadable account"}, ${t.succeeded ? "succeeded" : "did not succeed"}`,
            )
            .join("; ");
    const ok =
      intent !== null &&
      callOk &&
      sent.length === 1 &&
      sent[0].to === intent.destination &&
      sent[0].amount === intent.amount &&
      sent[0].deposit === "1" &&
      sent[0].succeeded &&
      s.transfers.length === 0;
    row({ ...transferBase, actual: shown, status: ok ? PASS : FAIL });
    return finish(block);
  }
  if (ledger.asset?.kind !== "NEAR_NATIVE") {
    row({
      ...transferBase,
      actual: `${assetText(ledger.asset)}: an asset this page cannot check`,
      status: ERROR,
    });
    return finish(block);
  }
  const transfers = s.transfers;
  const shown =
    transfers.length === 0
      ? "no transfer out of the escrow"
      : transfers
          .map((t) => `${formatNear(t.amount)} to ${t.to}, ${t.succeeded ? "succeeded" : "did not succeed"}`)
          .join("; ");
  const ok =
    intent !== null &&
    callOk &&
    transfers.length === 1 &&
    transfers[0].to === intent.destination &&
    transfers[0].amount === intent.amount &&
    transfers[0].succeeded;
  row({ ...transferBase, actual: shown, status: ok ? PASS : FAIL });
  return finish(block);
}
