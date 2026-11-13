/**
 * M54: the payment receipt verifier (site/proof/lib/receipt.mjs). The receipt page runs it in the
 * reader's browser: every fact on the receipt (parties, amount, asset, inspection result, the
 * release and its transaction) is read from NEAR at one final block and checked there, against
 * the code hash of the audited build in the proof manifest. Here it runs against a local server
 * replaying REAL read-only testnet answers (fixtures/proof/testnet-receipt-recording.json, written
 * by scripts/proof/record-receipt-fixture.mjs), unchanged and with exactly one fact altered.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANIFEST } from "../../../scripts/proof/build-manifest.mjs";
import { loadRecording, type Replay, startReplay } from "../../../scripts/proof/replay-rpc.mjs";
import {
  type ReceiptResult,
  parseReceiptLocation,
  receiptLink,
  receiptVerdict,
  verifyReceipt,
} from "../../../site/proof/lib/receipt.mjs";

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const RELEASE = "trd_197c633d724eeb2cddc64d6dabf55976";
const HOLD = "trd_75c1de55a8c9f1aa532ec37eb611f46f";
const REFUND = "trd_a54930d5d5af718e0fc8a8c9d43b9a2d";
const RELEASE_TX = "9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn";
const HOLD_TX = "2uSgWxtFqF5N9GRj5d7BR44B3xZnfy5ESjFh6KAKvGGf";
const ROWS = [
  "code-hash",
  "trade",
  "inspection",
  "release-intent",
  "approval-binding",
  "conservation",
  "released-total",
  "release-tx",
  "release-transfer",
];

let replay: Replay;
beforeAll(async () => {
  replay = await startReplay({ recording: loadRecording("testnet-receipt") });
});
afterAll(async () => {
  await replay.close();
});

const testnet = (...variants: string[]) => ({
  ...manifest.networks.testnet,
  rpc: variants.map((v) => replay.url(v)),
});
const run = (tradeId: string, variant = "recorded", extra: { txHash?: string; signer?: string } = {}) =>
  verifyReceipt(testnet(variant), { tradeId, ...extra });
const notPassing = (r: ReceiptResult) =>
  Object.fromEntries(r.rows.filter((x) => x.status !== "PASS").map((x) => [x.id, x.status]));
const row = (r: ReceiptResult, id: string) => r.rows.find((x) => x.id === id);

describe("M54 receipt verifier on recorded testnet answers", () => {
  it("passes every check of the release journey's receipt and lists the facts read from NEAR", async () => {
    const before = replay.requests();
    const r = await run(RELEASE);
    expect(notPassing(r)).toEqual({});
    expect(r.rows.map((x) => x.id)).toEqual(ROWS);
    expect(receiptVerdict(r)).toBe("PASS");
    expect(replay.requests() - before).toBe(r.rpcCalls);
    expect(r.facts).toMatchObject({
      tradeId: RELEASE,
      network: "near-testnet",
      contractId: "gnanam1990-dock-escrow2.testnet",
      codeHash: "7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N",
      buyer: "gnanam1990-dock-buyer.testnet",
      supplier: "gnanam1990-dock-supplier.testnet",
      payoutDestination: "gnanam1990-dock-supplier.testnet",
      amount: "50000000000000000000000",
      amountText: "0.05 NEAR",
      asset: { kind: "NEAR_NATIVE", network: "near-testnet" },
      assetText: "NEAR (native)",
      inspection: { decision: "PASS", reasonCodes: ["DOCS_MATCH"] },
      release: {
        intentId: "rli_abb154c802f92362dc09d32fe48888be",
        state: "PAID",
        amount: "50000000000000000000000",
        destination: "gnanam1990-dock-supplier.testnet",
      },
      tx: {
        hash: RELEASE_TX,
        source: "manifest",
        link: `https://testnet.nearblocks.io/txns/${RELEASE_TX}`,
      },
    });
    expect(r.facts?.release?.paidAt).toBe(1794537028671);
    expect(row(r, "release-transfer")).toMatchObject({
      expected: "0.05 NEAR to gnanam1990-dock-supplier.testnet",
      actual: "0.05 NEAR to gnanam1990-dock-supplier.testnet, succeeded",
    });
    expect(row(r, "release-tx")?.link).toBe(`https://testnet.nearblocks.io/txns/${RELEASE_TX}`);
  });

  it("passes the hold journey's receipt: the release came after the hold was resolved", async () => {
    const r = await run(HOLD);
    expect(notPassing(r)).toEqual({});
    expect(r.facts?.tx?.hash).toBe(HOLD_TX);
  });

  it("verifies a transaction named in the link rather than in the manifest", async () => {
    const r = await run(RELEASE, "recorded", {
      txHash: RELEASE_TX,
      signer: "gnanam1990-dock-relayer.testnet",
    });
    expect(notPassing(r)).toEqual({});
    expect(r.facts?.tx?.source).toBe("link");
  });

  it("fails when the link names a transaction that is not this trade's release", async () => {
    // A real, final, successful transaction: the hold journey's release, offered for another trade.
    const r = await run(RELEASE, "recorded", { txHash: HOLD_TX, signer: "gnanam1990-dock-relayer.testnet" });
    expect(notPassing(r)).toEqual({ "release-tx": "FAIL", "release-transfer": "FAIL" });
    expect(row(r, "release-tx")?.actual).toContain(HOLD);
    expect(receiptVerdict(r)).toBe("FAIL");
  });

  it("is red for a trade whose money went back to the funder: there is no paid release", async () => {
    const r = await run(REFUND);
    expect(receiptVerdict(r)).toBe("FAIL");
    expect(notPassing(r)).toMatchObject({ "release-intent": "FAIL" });
    expect(row(r, "release-intent")?.actual).toBe("no PAID release intent");
    expect(row(r, "code-hash")?.status).toBe("PASS");
  });

  it("fails the code hash when the escrow runs other code", async () => {
    const r = await run(RELEASE, "code-hash");
    expect(notPassing(r)).toEqual({ "code-hash": "FAIL" });
  });

  it("fails conservation when one yoctoNEAR is off", async () => {
    const r = await run(RELEASE, "ledger");
    expect(notPassing(r)).toEqual({ conservation: "FAIL" });
  });

  it("fails the inspection row when the recorded inspection did not pass", async () => {
    const r = await run(RELEASE, "inspection-fail");
    expect(notPassing(r)).toEqual({ inspection: "FAIL" });
    expect(row(r, "inspection")?.actual).toBe("FAIL (DOCS_MISMATCH)");
  });

  it("fails the release intent and the released total when the intent is not PAID", async () => {
    const r = await run(RELEASE, "release-unpaid");
    expect(notPassing(r)).toMatchObject({ "release-intent": "FAIL" });
  });

  it("fails the transaction row when the release transaction failed", async () => {
    const r = await run(RELEASE, "tx-failed");
    expect(notPassing(r)).toMatchObject({ "release-tx": "FAIL" });
  });

  it("fails the transfer row when the escrow paid someone else", async () => {
    const r = await run(RELEASE, "transfer-recipient");
    expect(notPassing(r)).toEqual({ "release-transfer": "FAIL" });
    expect(row(r, "release-transfer")?.actual).toBe("0.05 NEAR to someone-else.testnet, succeeded");
  });

  it("an unreadable transaction is an ERROR row and the verdict is not a pass", async () => {
    const r = await run(RELEASE, "tx-unknown");
    expect(notPassing(r)).toEqual({ "release-tx": "ERROR", "release-transfer": "ERROR" });
    expect(receiptVerdict(r)).toBe("FAIL");
  });

  it("an unreachable endpoint is one ERROR row and a FAIL verdict", async () => {
    const r = await run(RELEASE, "down");
    expect(r.rows.map((x) => x.status)).toEqual(["ERROR"]);
    expect(receiptVerdict(r)).toBe("FAIL");
  });

  it("an unknown trade is not a pass", async () => {
    const r = await run(`trd_${"0".repeat(32)}`);
    expect(row(r, "trade")?.status).toBe("ERROR");
    expect(receiptVerdict(r)).toBe("FAIL");
  });

  it("a network without a deployment sends no request and makes no claim", async () => {
    const before = replay.requests();
    const r = await verifyReceipt(manifest.networks.mainnet, { tradeId: RELEASE });
    expect(r.state).toBe("NOT_DEPLOYED");
    expect(receiptVerdict(r)).toBe("NOT_DEPLOYED");
    expect(replay.requests()).toBe(before);
  });

  it("refuses malformed input before any request", async () => {
    const before = replay.requests();
    for (const bad of [
      { tradeId: "x y" },
      { tradeId: RELEASE, txHash: "0OIl" },
      { tradeId: RELEASE, signer: "A!" },
    ])
      await expect(verifyReceipt(testnet("recorded"), bad)).rejects.toThrow(/not a valid/);
    expect(replay.requests()).toBe(before);
  });
});

describe("M54 receipt links", () => {
  it("parses /receipt/<trade id> and the static page's query form, with the transaction", () => {
    expect(parseReceiptLocation(`https://d.example/receipt/${RELEASE}?tx=${RELEASE_TX}`)).toEqual({
      tradeId: RELEASE,
      network: "testnet",
      txHash: RELEASE_TX,
    });
    expect(
      parseReceiptLocation(
        `https://o.github.io/dockside-near/receipt.html?trade=${HOLD}&network=testnet&signer=gnanam1990-dock-relayer.testnet`,
      ),
    ).toEqual({ tradeId: HOLD, network: "testnet", signer: "gnanam1990-dock-relayer.testnet" });
    expect(parseReceiptLocation("https://d.example/receipt.html")).toBeNull();
    expect(parseReceiptLocation("https://d.example/receipt/bad%20id")).toBeNull();
    expect(parseReceiptLocation(`https://d.example/receipt/${RELEASE}?network=devnet`)).toBeNull();
  });

  it("builds the link the QR code carries and parses it back", () => {
    const link = receiptLink("https://d.example", {
      tradeId: RELEASE,
      network: "testnet",
      txHash: RELEASE_TX,
    });
    expect(link).toBe(`https://d.example/receipt/${RELEASE}?network=testnet&tx=${RELEASE_TX}`);
    expect(parseReceiptLocation(link)).toEqual({ tradeId: RELEASE, network: "testnet", txHash: RELEASE_TX });
  });
});
