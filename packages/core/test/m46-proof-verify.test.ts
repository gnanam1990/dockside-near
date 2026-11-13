/**
 * M46: the proof verifier (site/proof/lib/verify.mjs), the code shared by the GitHub Pages proof
 * page and `pnpm judge`. It runs here against a local JSON-RPC server that replays REAL read-only
 * answers recorded from NEAR testnet (fixtures/proof/testnet-recording.json, written by
 * scripts/proof/record-fixture.mjs), unchanged and with exactly one recorded fact altered per
 * variant, so every check is shown to pass on the real data and to fail when the chain disagrees
 * with the manifest. The manifest itself must equal what the generator derives from the committed
 * run records under docs/evidence/.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58Encode as coreBase58 } from "@dockside/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildManifest, MANIFEST, render, SOURCES } from "../../../scripts/proof/build-manifest.mjs";
import { type Replay, startReplay } from "../../../scripts/proof/replay-rpc.mjs";
import { base58Encode, hexToBytes } from "../../../site/proof/lib/near-rpc.mjs";
import {
  checkConservation,
  formatNear,
  type ProofResult,
  verdict,
  verifyNetwork,
} from "../../../site/proof/lib/verify.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const RELEASE = "trd_197c633d724eeb2cddc64d6dabf55976";
const HOLD = "trd_75c1de55a8c9f1aa532ec37eb611f46f";
const REFUND = "trd_a54930d5d5af718e0fc8a8c9d43b9a2d";

let replay: Replay;
beforeAll(async () => {
  replay = await startReplay();
});
afterAll(async () => {
  await replay.close();
});

/** The committed testnet network, pointed at the replay server instead of the public endpoints. */
const testnet = (...variants: string[]) => ({
  ...manifest.networks.testnet,
  rpc: variants.map((v) => replay.url(v)),
});
const run = (...variants: string[]) => verifyNetwork(testnet(...variants), { downloadCode: false });
const notPassing = (r: ProofResult) =>
  Object.fromEntries(r.rows.filter((x) => x.status !== "PASS").map((x) => [x.id, x.status]));
const txIds = (tradeId: string, method?: string): string[] =>
  manifest.networks.testnet.journeys
    .find((j: { tradeId: string }) => j.tradeId === tradeId)
    .transactions.filter((t: { method: string }) => method === undefined || t.method === method)
    .map((t: { txHash: string }) => `tx:${t.txHash}`);

describe("M46 proof manifest", () => {
  it("the committed manifest is exactly what the run records under docs/evidence produce", () => {
    const built = render(buildManifest(JSON.parse(readFileSync(SOURCES, "utf8"))));
    expect(readFileSync(MANIFEST, "utf8").replace(/\r\n/g, "\n")).toBe(built);
    const r = spawnSync(process.execPath, ["scripts/proof/build-manifest.mjs", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("describes the hardened testnet deployment and its three journeys", () => {
    const t = manifest.networks.testnet;
    expect(t.deployment.contractId).toBe("gnanam1990-dock-escrow2.testnet");
    expect(t.deployment.artifact.nearCodeHash).toBe("7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N");
    expect(t.journeys.map((j: { kind: string }) => j.kind)).toEqual(["release", "hold", "refund"]);
    expect(t.journeys.flatMap((j: { transactions: unknown[] }) => j.transactions)).toHaveLength(26);
    expect(t.rpc.every((u: string) => u.startsWith("https://"))).toBe(true);
  });

  it("has no mainnet deployment until a mainnet run record is committed", () => {
    expect(manifest.networks.mainnet.deployment).toBeNull();
    expect(manifest.networks.mainnet.journeys).toEqual([]);
  });

  it("refuses run records that are not proof", () => {
    const sources = JSON.parse(readFileSync(SOURCES, "utf8"));
    const path = sources.networks.testnet.runs[0];
    const good = JSON.parse(readFileSync(join(ROOT, path), "utf8"));
    const withRecord = (rec: unknown, network = "testnet") =>
      buildManifest({ networks: { [network]: { ...sources.networks.testnet, runs: [path] } } }, () => rec);
    expect(withRecord(good).networks.testnet.journeys).toHaveLength(1);
    expect(() => withRecord({ ...good, journey: { ...good.journey, ok: false } })).toThrow(/did not pass/);
    expect(() => withRecord({ ...good, deployment: { ...good.deployment, match: false } })).toThrow(
      /did not match/,
    );
    expect(() => withRecord({ ...good, schema: "other@1" })).toThrow(/schema/);
    expect(() => withRecord(good, "mainnet")).toThrow(/listed under mainnet/);
    const other = { ...good, deployment: { ...good.deployment, contractId: "other.testnet" } };
    let n = 0;
    expect(() =>
      buildManifest({ networks: { testnet: { ...sources.networks.testnet, runs: [path, path] } } }, () =>
        n++ === 0 ? good : other,
      ),
    ).toThrow(/different deployment/);
  });
});

describe("M46 proof verifier on recorded testnet answers", () => {
  it("passes every check on the unchanged recording, reading only", async () => {
    const before = replay.requests();
    const r = await run("recorded");
    expect(notPassing(r)).toEqual({});
    expect(verdict(r)).toBe("PASS");
    expect(r.summary).toEqual({ total: 62, pass: 62, fail: 0, error: 0 });
    expect(r.block?.height).toBeGreaterThan(277_000_000);
    expect(replay.requests() - before).toBe(r.rpcCalls);
    expect(replay.methods()).toEqual(["EXPERIMENTAL_tx_status", "block", "query"]);
    // One row per journey transaction and the deployment transaction, each with an explorer link.
    const txRows = r.rows.filter((x) => x.txHash !== undefined);
    expect(txRows).toHaveLength(27);
    for (const x of txRows) expect(x.link).toBe(`https://testnet.nearblocks.io/txns/${x.txHash}`);
    expect(r.trades.map((t) => t.tradeId)).toEqual([RELEASE, HOLD, REFUND]);
  });

  it("shows the expected and the actual value of each check", async () => {
    const r = await run("recorded");
    const row = (id: string) => r.rows.find((x) => x.id === id);
    expect(row("code-hash")).toMatchObject({
      expected: "7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N",
      actual: "7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N",
    });
    expect(row(`${RELEASE}:released`)?.actual).toBe("0.05 NEAR (50000000000000000000000 yocto)");
    expect(row(`${REFUND}:refunded`)?.actual).toBe("0.06 NEAR (60000000000000000000000 yocto)");
    expect(row(`${REFUND}:conservation`)?.actual).toBe(
      "funded 60000000000000000000000 = refunded 60000000000000000000000",
    );
    expect(row(`${HOLD}:hold`)?.actual).toBe("RESOLVED, issuer POLICY_SETTER, rule doc-mismatch@1");
    expect(row(`${RELEASE}:transfers`)).toMatchObject({
      expected: "0.05 NEAR to gnanam1990-dock-supplier.testnet",
      actual: "0.05 NEAR to gnanam1990-dock-supplier.testnet",
    });
    expect(row(`${REFUND}:transfers`)?.actual).toBe(
      "0.01 NEAR to gnanam1990-dock-buyer.testnet; 0.05 NEAR to gnanam1990-dock-buyer.testnet",
    );
  });

  it("fails the code hash row when the account runs other code", async () => {
    const r = await run("code-hash");
    expect(notPassing(r)).toEqual({ "code-hash": "FAIL" });
    expect(r.rows.find((x) => x.id === "code-hash")?.actual).toBe("11111111111111111111111111111111");
    expect(verdict(r)).toBe("FAIL");
  });

  it("fails conservation when one yoctoNEAR is off, whatever the contract's own flag says", async () => {
    const r = await run("ledger");
    expect(notPassing(r)).toEqual({
      [`${RELEASE}:conservation`]: "FAIL",
      [`${HOLD}:conservation`]: "FAIL",
      [`${REFUND}:conservation`]: "FAIL",
    });
    expect(r.rows.find((x) => x.id === `${RELEASE}:conservation`)?.actual).toContain(
      "sum to 50000000000000000000001, funded 50000000000000000000000",
    );
    // The recorded flag still says true: the recomputation is what caught it.
    expect(r.rows.find((x) => x.id === `${RELEASE}:conservation-flag`)?.status).toBe("PASS");
  });

  it("fails a config row when the contract reports another value", async () => {
    const r = await run("config");
    expect(notPassing(r)).toEqual({ "config-min-deposit": "FAIL" });
  });

  it("fails the transaction rows of a failed transaction", async () => {
    const r = await run("tx-failed");
    expect(notPassing(r)).toEqual(
      Object.fromEntries(
        [...txIds(RELEASE, "execute_release"), ...txIds(HOLD, "execute_release")].map((id) => [id, "FAIL"]),
      ),
    );
    expect(r.rows.find((x) => x.id === txIds(RELEASE, "execute_release")[0])?.actual).toContain("FAILED");
  });

  it("fails the transfer cross-check when the escrow paid someone else", async () => {
    const r = await run("transfer-recipient");
    expect(notPassing(r)).toEqual({
      [`${RELEASE}:transfers`]: "FAIL",
      [`${HOLD}:transfers`]: "FAIL",
      [`${REFUND}:transfers`]: "FAIL",
    });
    expect(r.rows.find((x) => x.id === `${RELEASE}:transfers`)?.actual).toBe(
      "0.05 NEAR to someone-else.testnet",
    );
  });

  it("fails the relayer row when the key is a full-access key", async () => {
    const r = await run("relayer-full-access");
    expect(notPassing(r)).toEqual({ "relayer-key": "FAIL" });
  });

  it("fails the refund rows when a refund intent is not REFUNDED", async () => {
    const r = await run("refund-state");
    expect(notPassing(r)).toEqual({
      [`${REFUND}:refund-intents`]: "FAIL",
      [`${REFUND}:transfers`]: "FAIL",
    });
  });

  it("reports unreadable transactions as ERROR, never as a pass", async () => {
    const r = await run("tx-unknown");
    const bad = notPassing(r);
    for (const id of [...txIds(RELEASE), ...txIds(HOLD), ...txIds(REFUND), "deploy-tx"]) {
      expect(bad[id]).toBe("ERROR");
    }
    for (const t of [RELEASE, HOLD, REFUND]) expect(bad[`${t}:transfers`]).toBe("ERROR");
    expect(Object.keys(bad)).toHaveLength(27 + 3);
    expect(r.rows.find((x) => x.id === "deploy-tx")?.actual).toContain("could not be read");
    expect(verdict(r)).toBe("FAIL");
  });

  it("reports an unreachable endpoint as one ERROR row and no pass", async () => {
    const r = await run("down");
    expect(r.rows.map((x) => [x.id, x.status])).toEqual([["block", "ERROR"]]);
    expect(r.rows[0]?.actual).toContain("HTTP 503");
    expect(verdict(r)).toBe("FAIL");
  });

  it("falls back to the next endpoint when the first one is unavailable", async () => {
    const r = await run("down", "recorded");
    expect(verdict(r)).toBe("PASS");
    expect(r.summary.total).toBe(62);
  });

  it("checks the downloaded contract bytes against the manifest digest", async () => {
    const code = new Uint8Array(4096).map((_, i) => (i * 31) % 251);
    const sha256 = createHash("sha256").update(code).digest("hex");
    const nearCodeHash = base58Encode(hexToBytes(sha256));
    const base = testnet("recorded");
    const network = {
      ...base,
      deployment: {
        ...base.deployment,
        artifact: { ...base.deployment.artifact, bytes: code.length, sha256, nearCodeHash },
      },
    };
    // The recording has no view_code answer (1.1 MB), so this test answers the two code queries
    // itself and lets every other request reach the replay server.
    const serving =
      (bytes: Uint8Array): typeof fetch =>
      async (url, init) => {
        const req = JSON.parse(String(init?.body));
        const type = req.params?.request_type;
        const result =
          type === "view_code"
            ? { code_base64: Buffer.from(bytes).toString("base64") }
            : type === "view_account"
              ? { code_hash: nearCodeHash }
              : undefined;
        if (result === undefined) return fetch(url, init);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
      };
    const ok = await verifyNetwork(network, { fetch: serving(code) });
    expect(notPassing(ok)).toEqual({});
    expect(ok.summary.total).toBe(63);
    expect(ok.rows.find((x) => x.id === "code-bytes")?.actual).toBe(`4096 bytes, sha256 ${sha256}`);
    const flipped = code.slice();
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    const bad = await verifyNetwork(network, { fetch: serving(flipped) });
    expect(notPassing(bad)).toEqual({ "code-bytes": "FAIL" });
    // Without an answer the row is an error, not a pass.
    const missing = await verifyNetwork(testnet("recorded"));
    expect(notPassing(missing)).toEqual({ "code-bytes": "ERROR" });
  });

  it("makes no request for a network without a deployment", async () => {
    const r = await verifyNetwork(manifest.networks.mainnet, {
      fetch: () => {
        throw new Error("no request expected");
      },
    });
    expect(r.state).toBe("NOT_DEPLOYED");
    expect(r.rows).toEqual([]);
    expect(r.rpcCalls).toBe(0);
    expect(verdict(r)).toBe("NOT_DEPLOYED");
  });
});

describe("M46 proof helpers", () => {
  const funder = {
    funded: "60",
    partial: "0",
    available: "10",
    reserved: "0",
    released: "30",
    refundLocked: "0",
    refunded: "20",
    quarantined: "0",
    fees: "0",
  };
  const ledger = {
    required: "50",
    committed: "40",
    totals: { ...funder },
    funders: { "a.testnet": { ...funder } },
    deposits: [{ amount: "25" }, { amount: "35" }],
  };

  it("recomputes conservation from the buckets", () => {
    expect(checkConservation(ledger)).toMatchObject({
      ok: true,
      funded: "60",
      equation: "funded 60 = available 10 + released 30 + refunded 20",
    });
    const off = (patch: object) => checkConservation({ ...ledger, ...patch }).problems.join("|");
    expect(off({ deposits: [{ amount: "59" }] })).toContain("deposits sum to 59");
    expect(off({ funders: { "a.testnet": { ...funder, refunded: "21" } } })).toContain("sum to 61");
    expect(off({ totals: { ...funder, released: "31" } })).toContain("totals.released 31");
    expect(off({ committed: "39" })).toContain("committed 39");
    expect(off({ required: "39" })).toContain("exceeds required 39");
    expect(off({ totals: { ...funder, fees: 0 } })).toContain("malformed ledger");
  });

  it("formats yoctoNEAR exactly", () => {
    expect(formatNear("50000000000000000000000")).toBe("0.05 NEAR");
    expect(formatNear("0")).toBe("0 NEAR");
    expect(formatNear("1000000000000000000000001")).toBe("1.000000000000000000000001 NEAR");
    expect(formatNear("12000000000000000000000000")).toBe("12 NEAR");
  });

  it("encodes base58 like the core package, so a SHA-256 maps to its NEAR code hash", () => {
    const a = manifest.networks.testnet.deployment.artifact;
    expect(base58Encode(hexToBytes(a.sha256))).toBe(a.nearCodeHash);
    for (const hex of [a.sha256, "00", "0000ff", "ff".repeat(32)]) {
      expect(base58Encode(hexToBytes(hex))).toBe(coreBase58(hexToBytes(hex)));
    }
    expect(() => hexToBytes("xyz")).toThrow();
  });
});
