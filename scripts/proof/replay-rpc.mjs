// Test tool: a local JSON-RPC server that replays the recorded real NEAR answers of
// fixtures/proof/<network>-recording.json (see record-fixture.mjs). The unit, judge and browser
// suites point the real verifier at it, so they need no network.
//
// The path selects the variant: /rpc/recorded replays the answers unchanged; every other name in
// MUTATIONS alters exactly one recorded fact, to prove that the verifier reports a FAIL (or an
// ERROR) when the chain disagrees with the manifest. A request that was never recorded gets a
// JSON-RPC error, as an unreachable value should. /rpc/down answers HTTP 503.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Stable key of a request: the method and its params without the block reference. */
export function requestKey(req) {
  const { finality: _f, block_id: _b, ...params } = req.params ?? {};
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${req.method} ${JSON.stringify(sorted)}`;
}

const isView = (req, method) =>
  req.method === "query" && req.params.request_type === "call_function" && req.params.method_name === method;
const viewJson = (result) => JSON.parse(Buffer.from(result.result).toString());
const withJson = (result, value) => ({ ...result, result: [...Buffer.from(JSON.stringify(value))] });
const isTx = (req) => req.method === "EXPERIMENTAL_tx_status";

/** name -> (request, recorded result) => result to send, or undefined to answer with an error. */
export const MUTATIONS = {
  recorded: (_req, result) => result,
  // The account runs other code than the manifest says.
  "code-hash": (req, result) =>
    req.params?.request_type === "view_account"
      ? { ...result, code_hash: "11111111111111111111111111111111" }
      : result,
  // One yoctoNEAR too much in a released bucket: conservation is broken.
  ledger: (req, result) => {
    if (!isView(req, "get_ledger")) return result;
    const ledger = viewJson(result);
    const funder = Object.values(ledger.funders)[0];
    funder.released = (BigInt(funder.released) + 1n).toString();
    return withJson(result, ledger);
  },
  // The contract reports a different minimum deposit than the manifest.
  config: (req, result) =>
    isView(req, "get_config") ? withJson(result, { ...viewJson(result), minDepositYocto: "1" }) : result,
  // A journey transaction failed.
  "tx-failed": (req, result) =>
    isTx(req) && result.transaction.actions[0]?.FunctionCall?.method_name === "execute_release"
      ? { ...result, status: { Failure: { ActionError: { index: 0, kind: "FunctionCallError" } } } }
      : result,
  // The escrow paid a different account than the contract recorded.
  "transfer-recipient": (req, result) =>
    isTx(req)
      ? {
          ...result,
          receipts: result.receipts.map((r) =>
            r.predecessor_id !== "system" && r.receipt?.Action?.actions?.some((a) => a.Transfer)
              ? { ...r, receiver_id: "someone-else.testnet" }
              : r,
          ),
        }
      : result,
  // The relayer key became a full-access key.
  "relayer-full-access": (req, result) =>
    req.params?.request_type === "view_access_key" ? { ...result, permission: "FullAccess" } : result,
  // A refund intent is not in its final state.
  "refund-state": (req, result) =>
    isView(req, "get_refunds")
      ? withJson(
          result,
          viewJson(result).map((r) => ({ ...r, state: "AUTHORIZED" })),
        )
      : result,
  // The node does not know the transactions.
  "tx-unknown": (req, result) => (isTx(req) ? undefined : result),
  // Receipt (M54): the inspection recorded on the contract did not pass.
  "inspection-fail": (req, result) => {
    if (!isView(req, "get_evidence")) return result;
    const ev = viewJson(result);
    if (ev.inspection) ev.inspection = { ...ev.inspection, decision: "FAIL", reasonCodes: ["DOCS_MISMATCH"] };
    return withJson(result, ev);
  },
  // Receipt (M54): the release intent never reached PAID.
  "release-unpaid": (req, result) =>
    isView(req, "get_release")
      ? withJson(result, {
          ...viewJson(result),
          intents: viewJson(result).intents.map((i) => ({ ...i, state: "SUBMITTING" })),
        })
      : result,
  // Receipt (M50 on M54): the same trade as a NEP-141 token trade, paid by the escrow's
  // `ft_transfer` on the token contract instead of a native transfer (the asset and the payout
  // receipt rewritten; every other recorded fact unchanged).
  nep141: (req, result) => asNep141(req, result),
  // ... and that `ft_transfer` names another receiver than the paid intent.
  "nep141-recipient": (req, result) => asNep141(req, result, "someone-else.testnet"),
};

/** The token of the NEP-141 variants: Circle's USDC contract on NEAR testnet, 6 decimals. */
export const NEP141_TOKEN = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

function asNep141(req, result, receiver) {
  if (isView(req, "get_ledger")) {
    const ledger = viewJson(result);
    ledger.asset = {
      kind: "NEP141",
      network: ledger.asset.network,
      tokenAccountId: NEP141_TOKEN,
      decimals: 6,
    };
    return withJson(result, ledger);
  }
  if (!isTx(req)) return result;
  const escrow = result.transaction.receiver_id;
  return {
    ...result,
    receipts: result.receipts.map((r) => {
      const pay =
        r.predecessor_id === escrow && r.receiver_id !== escrow
          ? r.receipt?.Action?.actions?.[0]?.Transfer
          : undefined;
      if (!pay) return r;
      const args = { receiver_id: receiver ?? r.receiver_id, amount: pay.deposit, memo: "dockside release" };
      const call = {
        method_name: "ft_transfer",
        args: Buffer.from(JSON.stringify(args)).toString("base64"),
        deposit: "1",
        gas: 10_000_000_000_000,
      };
      return {
        ...r,
        receiver_id: NEP141_TOKEN,
        receipt: { ...r.receipt, Action: { ...r.receipt.Action, actions: [{ FunctionCall: call }] } },
      };
    }),
  };
}

/** `testnet` reads fixtures/proof/testnet-recording.json; `testnet-receipt` the receipt recording (M54). */
export function loadRecording(network = "testnet") {
  if (!/^[a-z]+(-[a-z]+)?$/.test(network)) throw new Error(`not a recording name: ${network}`);
  return JSON.parse(readFileSync(join(ROOT, `fixtures/proof/${network}-recording.json`), "utf8"));
}

/**
 * @param {{port?: number, recording?: object}} [options]
 * @returns {Promise<{url: (variant?: string) => string, requests: () => number, methods: () => string[], close: () => Promise<void>}>}
 */
export function startReplay({ port = 0, recording = loadRecording() } = {}) {
  let requests = 0;
  const methods = new Set();
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const variant = /^\/rpc\/([\w-]+)$/.exec(req.url ?? "")?.[1];
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests++;
      const send = (status, body) =>
        res.writeHead(status, { "content-type": "application/json", ...cors }).end(JSON.stringify(body));
      if (req.method !== "POST" || variant === undefined) return send(404, { error: "not found" });
      if (variant === "down") return send(503, { error: "unavailable" });
      const mutate = MUTATIONS[variant];
      if (!mutate) return send(404, { error: `unknown variant ${variant}` });
      let rpc;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return send(400, { error: "bad request" });
      }
      methods.add(rpc.method);
      const recorded = recording.answers[requestKey(rpc)];
      const result = recorded === undefined ? undefined : mutate(rpc, structuredClone(recorded));
      if (result === undefined) {
        return send(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { name: "HANDLER_ERROR", cause: { name: "NOT_RECORDED" }, message: "not in the recording" },
        });
      }
      send(200, { jsonrpc: "2.0", id: rpc.id, result });
    });
  });
  return new Promise((ok, no) => {
    server.once("error", no);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      ok({
        url: (variant = "recorded") => `http://127.0.0.1:${actual}/rpc/${variant}`,
        requests: () => requests,
        methods: () => [...methods].sort(),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
