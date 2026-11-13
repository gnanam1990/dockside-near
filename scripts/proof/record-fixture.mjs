// Records the read-only RPC answers the proof verifier needs, for the offline regression suites.
// It runs the real verifier (site/proof/lib/verify.mjs) against the real endpoints of one network
// of the proof manifest and stores every request with its answer in fixtures/proof/. The answers
// are trimmed of gas profiles, block chunks and merkle proofs, which the verifier never reads;
// nothing else is changed. The 1.1 MB contract code download (view_code) is not recorded.
//
// Usage: node scripts/proof/record-fixture.mjs [network]     (default testnet; read-only)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { verdict, verifyNetwork } from "../../site/proof/lib/verify.mjs";
import { MANIFEST, ROOT } from "./build-manifest.mjs";
import { requestKey } from "./replay-rpc.mjs";

const name = process.argv[2] ?? "testnet";
const network = JSON.parse(readFileSync(MANIFEST, "utf8")).networks[name];
if (!network?.deployment) {
  process.stderr.write(`record-fixture: the manifest has no deployment on ${name}\n`);
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

const result = await verifyNetwork(network, { fetch: recordingFetch, downloadCode: false, concurrency: 2 });
if (verdict(result) !== "PASS") {
  process.stderr.write(`record-fixture: the live run did not pass (${JSON.stringify(result.summary)})\n`);
  process.exit(1);
}
const file = join(ROOT, `fixtures/proof/${name}-recording.json`);
mkdirSync(dirname(file), { recursive: true });
// One answer per line: the view results are byte arrays, which an indented dump would spread over
// tens of thousands of lines.
const head = {
  schema: "dockside/proof-recording@1",
  network: name,
  recordedAt: new Date().toISOString(),
  rpc: network.rpc[0],
  block: result.block,
  note: "Real read-only answers; gas profiles, block chunks and merkle proofs removed. No transaction was sent.",
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
writeFileSync(file, text.join("\n"));
process.stdout.write(`recorded ${Object.keys(answers).length} answers at block ${result.block.height}\n`);
