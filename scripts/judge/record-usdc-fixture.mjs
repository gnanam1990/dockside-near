// Records the read-only RPC answers the USDC judge step (scripts/judge/usdc.mjs) needs, for the
// offline regression suite: fixtures/proof/testnet-usdc-recording.json. It runs the real check
// against the real testnet endpoints and stores every request with its answer. Transaction answers
// keep only the fields the check reads (the transaction's signer, receiver and actions, the
// status, the receipts and each receipt outcome's executor, status and logs); nothing is altered.
//
// Usage: node scripts/judge/record-usdc-fixture.mjs     (read-only; sends no transaction)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../proof/build-manifest.mjs";
import { requestKey } from "../proof/replay-rpc.mjs";
import { loadUsdcEvidence, USDC_RPC, verifyUsdc } from "./usdc.mjs";

function trimTx(r) {
  return {
    final_execution_status: r.final_execution_status,
    status: r.status,
    transaction: {
      signer_id: r.transaction.signer_id,
      receiver_id: r.transaction.receiver_id,
      actions: r.transaction.actions,
    },
    receipts: (r.receipts ?? []).map((x) => ({
      receipt_id: x.receipt_id,
      predecessor_id: x.predecessor_id,
      receiver_id: x.receiver_id,
      receipt: x.receipt?.Action ? { Action: { actions: x.receipt.Action.actions } } : {},
    })),
    receipts_outcome: (r.receipts_outcome ?? []).map((o) => ({
      id: o.id,
      outcome: { executor_id: o.outcome.executor_id, status: o.outcome.status, logs: o.outcome.logs },
    })),
  };
}

const answers = {};
const recordingFetch = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.clone().json();
  const req = JSON.parse(init.body);
  if (body.result !== undefined && body.error === undefined) {
    let result = body.result;
    if (req.method === "EXPERIMENTAL_tx_status") result = trimTx(result);
    else if (req.method === "query") {
      const { block_hash: _h, block_height: _b, ...rest } = result;
      result = rest;
    }
    answers[requestKey(req)] = result;
  }
  return res;
};

const { rows } = await verifyUsdc(loadUsdcEvidence(ROOT), { fetch: recordingFetch, concurrency: 2 });
const bad = rows.filter((r) => r.status !== "PASS");
if (bad.length > 0) {
  process.stderr.write(`record-usdc-fixture: the live run did not pass (${bad.length} rows)\n`);
  process.exit(1);
}
const head = {
  schema: "dockside/proof-recording@1",
  network: "testnet-usdc",
  recordedAt: new Date().toISOString(),
  rpc: USDC_RPC[0],
  note: "Real read-only answers for scripts/judge/usdc.mjs; transaction answers trimmed to the fields it reads. No transaction was sent.",
};
const lines = Object.entries(answers).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
const text = [
  `${JSON.stringify(head, null, 1).slice(0, -2)},`,
  ' "answers": {',
  lines.join(",\n"),
  " }",
  "}",
  "",
];
writeFileSync(join(ROOT, "fixtures/proof/testnet-usdc-recording.json"), text.join("\n"));
process.stdout.write(`recorded ${Object.keys(answers).length} answers\n`);
