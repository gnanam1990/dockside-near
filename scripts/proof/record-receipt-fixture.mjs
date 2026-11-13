// Records the read-only RPC answers the payment receipt verifier (site/proof/lib/receipt.mjs)
// needs, for the offline regression suites (M54). It runs the real receipt verifier against the
// real endpoints for every journey trade of one network of the proof manifest and stores every
// request with its answer in fixtures/proof/<network>-receipt-recording.json, trimmed the same way
// as record-fixture.mjs. The trades that paid a supplier must verify; a trade that paid nothing
// out to a supplier (the refund journey) must not.
//
// Usage: node scripts/proof/record-receipt-fixture.mjs [network]     (default testnet; read-only)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { receiptVerdict, verifyReceipt } from "../../site/proof/lib/receipt.mjs";
import { MANIFEST, ROOT } from "./build-manifest.mjs";
import { requestKey } from "./replay-rpc.mjs";

const name = process.argv[2] ?? "testnet";
const network = JSON.parse(readFileSync(MANIFEST, "utf8")).networks[name];
if (!network?.deployment) {
  process.stderr.write(`record-receipt-fixture: the manifest has no deployment on ${name}\n`);
  process.exit(2);
}

function trim(v) {
  if (Array.isArray(v)) return v.map(trim);
  if (v === null || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "proof" || k === "metadata" || k === "chunks") continue;
    out[k] = trim(x);
  }
  return out;
}

const answers = {};
const recordingFetch = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.clone().json();
  const req = JSON.parse(init.body);
  if (body.result !== undefined && body.error === undefined) answers[requestKey(req)] = trim(body.result);
  return res;
};

let block = null;
for (const j of network.journeys) {
  const r = await verifyReceipt(network, { tradeId: j.tradeId }, { fetch: recordingFetch });
  block ??= r.block;
  const want = j.kind === "refund" ? "FAIL" : "PASS";
  const got = receiptVerdict(r);
  process.stdout.write(`${j.kind} ${j.tradeId}: ${got} (${JSON.stringify(r.summary)})\n`);
  if (got !== want) {
    process.stderr.write(`record-receipt-fixture: expected ${want} for the ${j.kind} journey\n`);
    process.exit(1);
  }
}
const file = join(ROOT, `fixtures/proof/${name}-receipt-recording.json`);
mkdirSync(dirname(file), { recursive: true });
const head = {
  schema: "dockside/proof-recording@1",
  network: name,
  recordedAt: new Date().toISOString(),
  rpc: network.rpc[0],
  block,
  note: "Real read-only answers for the payment receipt verifier; gas profiles, block chunks and merkle proofs removed. No transaction was sent.",
};
const lines = Object.entries(answers).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
writeFileSync(
  file,
  [`${JSON.stringify(head, null, 1).slice(0, -2)},`, ' "answers": {', lines.join(",\n"), " }", "}", ""].join(
    "\n",
  ),
);
process.stdout.write(`recorded ${Object.keys(answers).length} answers at block ${block?.height}\n`);
