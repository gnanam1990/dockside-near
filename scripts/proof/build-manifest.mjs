// Builds site/proof/proof-manifest.json: the EXPECTED values the proof page and `pnpm judge`
// compare with what they read from NEAR.
//
// The manifest is derived only from committed run records (docs/evidence/**/run-record.json,
// written by scripts/testnet-deploy/run-all when the owner ran a journey) listed in
// scripts/proof/sources.json. A network with no run record has `deployment: null`, and the page
// shows "not deployed yet" for it. To add a deployment or a journey: commit its run record, add
// the path to sources.json and run `pnpm run proof:manifest`.
//
// Usage: node scripts/proof/build-manifest.mjs            write the manifest
//        node scripts/proof/build-manifest.mjs --check    exit 1 when the committed file is stale
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SOURCES = join(ROOT, "scripts/proof/sources.json");
export const MANIFEST = join(ROOT, "site/proof/proof-manifest.json");
const RUN_SCHEMA = "dockside/testnet-run@1";

const fail = (msg) => {
  throw new Error(`proof manifest: ${msg}`);
};

function journeyOf(record, path) {
  const j = record.journey;
  if (j?.ok !== true) fail(`${path}: the journey did not pass; only passed runs are proof`);
  const c = j.checks ?? {};
  const kind = j.kind ?? "release";
  const expected = { released: c.releasedTotal ?? "0", refunded: c.buyerRefundedYocto ?? "0", refunds: [] };
  if (c.buyerFundedYocto !== undefined) expected.funded = c.buyerFundedYocto;
  if (j.releaseIntentId) {
    if (c.releasePaid !== true) fail(`${path}: release intent without releasePaid`);
    expected.release = { intentId: j.releaseIntentId, amount: c.releasedTotal };
    expected.funded ??= c.releasedTotal;
  }
  if (c.holdSetBy !== undefined) {
    const m = /^(\w+) \((.+)\)$/.exec(c.holdSetBy);
    if (!m || c.holdResolved !== true) fail(`${path}: unreadable hold checks`);
    expected.hold = { issuerRole: m[1], ruleId: m[2] };
  }
  for (const r of c.buyerReceived ?? []) {
    expected.refunds.push({ refundIntentId: r.refundIntentId, reason: r.reason, amount: r.amount });
  }
  return {
    kind,
    tradeId: j.tradeId,
    evidence: dirname(path),
    expected,
    transactions: j.transactions.map((t) => ({
      step: t.step ?? t.method,
      method: t.method,
      signer: t.signer,
      txHash: t.txHash,
    })),
  };
}

export function buildManifest(sources, read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"))) {
  const networks = {};
  for (const [name, src] of Object.entries(sources.networks)) {
    const net = { label: src.label, rpc: src.rpc, explorer: src.explorer, deployment: null, journeys: [] };
    networks[name] = net;
    for (const path of src.runs) {
      const rec = read(path);
      if (rec.schema !== RUN_SCHEMA) fail(`${path}: schema ${rec.schema}`);
      if (rec.network !== name) fail(`${path}: run on ${rec.network}, listed under ${name}`);
      if (rec.deployment?.match !== true) fail(`${path}: the deployed code hash did not match the artifact`);
      const dep = {
        contractId: rec.deployment.contractId,
        artifact: rec.artifact,
        deployTx: null,
        config: {
          network: rec.deployment.config.network,
          minDepositYocto: rec.deployment.config.minDepositYocto,
          refundPolicy: rec.deployment.config.refundPolicy,
        },
        relayer: { account: rec.relayer.relayer, publicKey: rec.relayer.publicKey },
      };
      if (net.deployment === null) net.deployment = dep;
      const first = net.deployment;
      if (first.contractId !== dep.contractId || first.artifact.nearCodeHash !== dep.artifact.nearCodeHash) {
        fail(`${path}: a different deployment than the other ${name} runs`);
      }
      if (JSON.stringify(first.config) !== JSON.stringify(dep.config)) fail(`${path}: a different config`);
      first.relayer = dep.relayer;
      // near-cli-rs deploys from the contract account itself (docs/evidence/M34 near-cli-summary).
      if (rec.deployTx) first.deployTx = { hash: rec.deployTx, signer: dep.contractId };
      net.journeys.push(journeyOf(rec, path));
    }
  }
  return { schema: "dockside/proof-manifest@1", networks };
}

export const render = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = render(buildManifest(JSON.parse(readFileSync(SOURCES, "utf8"))));
  if (process.argv.includes("--check")) {
    const current = existsSync(MANIFEST) ? readFileSync(MANIFEST, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== text) {
      process.stderr.write("proof manifest is stale: run `pnpm run proof:manifest`\n");
      process.exit(1);
    }
    process.stdout.write("proof manifest is current\n");
  } else {
    writeFileSync(MANIFEST, text);
    process.stdout.write(
      `wrote ${MANIFEST.slice(ROOT.length + 1)
        .split("\\")
        .join("/")}\n`,
    );
  }
}
