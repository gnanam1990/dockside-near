/**
 * M53: the attack console's read side (site/proof/lib/attack-read.mjs), on the REAL answers of a
 * local nearcore sandbox node recorded by m53-attack-sandbox.test.ts (fixtures/attack/), unchanged
 * or with one fact altered. The page judges every attempt from these answers itself.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requestKey } from "../../../scripts/proof/replay-rpc.mjs";
import {
  attemptCount,
  formatAmount,
  formatNear,
  fundsState,
  judgeAttempt,
  keyScope,
  ATTACKS as PAGE_ATTACKS,
  recordedFor,
  tradeAsset,
} from "../../../site/proof/lib/attack-read.mjs";
import { ATTACKS, parseDemoConfig } from "../src/attack/attacks.js";

type Json = Record<string, unknown>;
const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/attack/${f}`, import.meta.url), "utf8"));
const recording = fixture("sandbox-recording.json") as { answers: Record<string, unknown> };
const demo = fixture("sandbox-demo.json") as Json & {
  escrow: string;
  tradeId: string;
  attacker: { accountId: string; publicKey: string };
  recorded: { attack: string; txHash: string; code: string }[];
};
const answer = (method: string, params: Json) =>
  structuredClone(recording.answers[requestKey({ method, params })]) as Json;
const view = (m: string): any => {
  const r = answer("query", {
    request_type: "call_function",
    account_id: demo.escrow,
    method_name: m,
    args_base64: Buffer.from(JSON.stringify({ trade_id: demo.tradeId })).toString("base64"),
  });
  return JSON.parse(Buffer.from(r["result"] as number[]).toString());
};
const tx = (hash: string) =>
  answer("EXPERIMENTAL_tx_status", {
    tx_hash: hash,
    sender_account_id: demo.attacker.accountId,
    wait_until: "FINAL",
  });

describe("page and relay agree on the five attacks", () => {
  it("the page's list is the relay's list", () => {
    expect(PAGE_ATTACKS).toEqual(ATTACKS.map((a) => ({ ...a })));
  });
  it("the recorded sandbox demo config is a valid live config", () => {
    expect(parseDemoConfig(demo).status).toBe("LIVE");
  });
});

describe("judging a recorded attempt", () => {
  it("every recorded attempt is a final, failed escrow receipt from the attacker with its code", () => {
    expect(demo.recorded.map((r) => r.attack)).toEqual([...ATTACKS.map((a) => a.id), "release-during-hold"]);
    for (const r of demo.recorded) {
      const spec = ATTACKS.find((a) => a.id === r.attack);
      const j = judgeAttempt(tx(r.txHash), {
        escrow: demo.escrow,
        signer: demo.attacker.accountId,
        method: String(spec?.method),
      });
      expect(j).toMatchObject({
        final: true,
        ranOnEscrow: true,
        refused: true,
        signerOk: true,
        receiverOk: true,
        methodOk: true,
      });
      expect(j.code).toBe(spec?.expect);
      expect(j.rawError).toContain(`DOCKSIDE:${j.code}: `);
    }
  });
  it("lists every blocker of a refused release", () => {
    const r = demo.recorded.find((x) => x.attack === "release-during-hold");
    expect(judgeAttempt(tx(String(r?.txHash)), { escrow: demo.escrow }).blockers).toEqual([
      "HOLD_ACTIVE",
      "APPROVAL_STALE",
    ]);
  });
  it("a success, another signer or another receiver is not a refusal of this demo", () => {
    const t = tx(String(demo.recorded[0]?.txHash));
    const ok = structuredClone(t) as { receipts_outcome: { outcome: Json }[] };
    for (const o of ok.receipts_outcome) o.outcome["status"] = { SuccessValue: "" };
    expect(judgeAttempt(ok, { escrow: demo.escrow }).refused).toBe(false);
    expect(judgeAttempt(t, { escrow: demo.escrow, signer: "someone.testnet" }).signerOk).toBe(false);
    expect(judgeAttempt(t, { escrow: "other.testnet" }).ranOnEscrow).toBe(false);
    expect(judgeAttempt(undefined, { escrow: demo.escrow }).refused).toBe(false);
  });
});

describe("funds and counter", () => {
  const read = () => ({ ledger: view("get_ledger"), release: view("get_release"), holds: view("get_holds") });
  it("the sandbox trade is in its demo state after six attempts", () => {
    const f = fundsState(demo, read());
    expect(f.unchanged).toBe(true);
    expect(f.rows.map((r) => [r.id, r.actual])).toEqual([
      ["funded", 20_000_000_000_000_000_000_000n],
      ["reserved", 20_000_000_000_000_000_000_000n],
      ["released", 0n],
      ["refunded", 0n],
      ["refundLocked", 0n],
    ]);
    expect(f.intentState).toBe("DIRECT_TESTNET_AUTHORIZED");
    const key = answer("query", {
      request_type: "view_access_key",
      account_id: demo.attacker.accountId,
      public_key: demo.attacker.publicKey,
    });
    expect(attemptCount(key, demo)).toBe(6n);
    expect(keyScope(key, demo)).toMatchObject({ functionCallOnly: true, restrictedToEscrow: true });
    expect(formatNear(20_000_000_000_000_000_000_000n)).toBe("0.02 NEAR");
  });
  it("one moved yoctoNEAR, a paid intent, a lifted hold or another payout each break it", () => {
    const moved = read();
    moved.ledger.totals.released = "1";
    expect(fundsState(demo, moved).unchanged).toBe(false);
    const paid = read();
    paid.release.intents[0].state = "PAID";
    expect(fundsState(demo, paid).checks["notPaid"]).toBe(false);
    const lifted = read();
    lifted.holds[0].resolution = { code: "RELEASE_HOLD" };
    expect(fundsState(demo, lifted).checks["holdBlocking"]).toBe(false);
    const other = read();
    other.release.payoutDestination = demo.attacker.accountId;
    expect(fundsState(demo, other).checks["payoutToBoundSupplier"]).toBe(false);
    expect(attemptCount(undefined, demo)).toBeNull();
    expect(keyScope({ permission: "FullAccess" }, demo).restrictedToEscrow).toBe(false);
  });
  it("replays the newest recorded attempt of each attack", () => {
    expect(recordedFor(demo, "release-during-hold")?.txHash).toBe(demo.recorded[5]?.txHash);
    expect(recordedFor({ recorded: [] }, "change-payout")).toBeNull();
  });
});

describe("amounts in the trade's asset", () => {
  const live = JSON.parse(
    readFileSync(new URL("../../../site/proof/attack/attack-demo.json", import.meta.url), "utf8"),
  ) as Json;
  const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

  it("takes the asset from the ledger the chain returned, else from the registered terms", () => {
    expect(tradeAsset(demo, { ledger: view("get_ledger") })).toEqual({
      kind: "NEAR_NATIVE",
      network: "near-testnet",
    });
    expect(tradeAsset(demo, { ledger: null })).toEqual({ kind: "NEAR_NATIVE", network: "near-testnet" });
    // The committed live demo is a USDC trade: 6 decimals, Circle's testnet token contract.
    expect(tradeAsset(live, { ledger: null })).toEqual({
      kind: "NEP141",
      network: "near-testnet",
      tokenAccountId: USDC,
      decimals: 6,
    });
    expect(tradeAsset({ terms: null }, { ledger: null })).toBeNull();
  });

  it("states USDC held by the live demo trade as USDC, not as NEAR", () => {
    const asset = tradeAsset(live, { ledger: null });
    expect(formatAmount(2_000_000n, asset, "USDC")).toBe("2.00 USDC");
    expect(formatAmount(live["amountYocto"] as string, asset, "USDC")).toBe("2.00 USDC");
    expect(formatAmount(2_000_000n, asset, null)).toBe(`2.00 tokens of ${USDC}`);
    expect(formatAmount(0n, asset, "USDC")).toBe("0.00 USDC");
    expect(formatAmount(-1n, asset, "USDC")).toBe("unreadable");
    // NEAR keeps its own rendering.
    expect(formatAmount(20_000_000_000_000_000_000_000n, { kind: "NEAR_NATIVE" }, null)).toBe("0.02 NEAR");
  });
});
