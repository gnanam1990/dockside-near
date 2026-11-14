/**
 * M61: the USDC step of `pnpm judge` (scripts/judge/usdc.mjs). The real check runs against a local
 * server replaying real recorded testnet answers for gnanam1990-dock-escrow3.testnet
 * (fixtures/proof/testnet-usdc-recording.json, recorded by scripts/judge/record-usdc-fixture.mjs):
 * unchanged for PASS, and with one fact altered for FAIL or ERROR. The expected values come from
 * the committed evidence docs/evidence/M56/onchain-reverify.json.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEP_NAMES } from "../../../scripts/judge/judge.mjs";
import { loadUsdcEvidence, panicCode, verifyUsdc } from "../../../scripts/judge/usdc.mjs";
import { loadRecording, type Replay, startReplay } from "../../../scripts/proof/replay-rpc.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const evidence = loadUsdcEvidence(ROOT);
const dir = mkdtempSync(join(tmpdir(), "dockside-m61-judge-"));
let replay: Replay;
beforeAll(async () => {
  replay = await startReplay({ recording: loadRecording("testnet-usdc") });
});
afterAll(async () => {
  await replay.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (variant: string) => verifyUsdc(evidence, { rpc: [replay.url(variant)], timeoutMs: 5_000 });

describe("M61 pnpm judge, USDC escrow3 step against recorded testnet answers", () => {
  it("is a judge step that prints its rows in the judge table", async () => {
    expect(STEP_NAMES).toContain("usdc");
    const out = await new Promise<{ status: number; text: string }>((done) => {
      execFile(
        process.execPath,
        [
          join(ROOT, "scripts/judge/judge.mjs"),
          "--only",
          "usdc",
          "--usdc-rpc",
          replay.url("recorded"),
          "--report",
          join(dir, "report.json"),
        ],
        { cwd: ROOT, encoding: "utf8" },
        (error, stdout) => done({ status: error ? Number(error.code ?? 1) : 0, text: stdout }),
      );
    });
    expect(out.text).toMatch(
      /USDC balance of the supplier at block 277529142\s+\| 15 USDC\s+\| 15 USDC\s+\| PASS/,
    );
    expect(out.text).toMatch(/JUDGE: PASS {2}23 passed, 0 failed, 0 not readable, 5 skipped/);
    expect(out.status).toBe(0);
  });

  it("passes every row on the recorded answers: deployment, 48 transactions, 6 refusals, 4 ledgers, balances", async () => {
    const { rows } = await run("recorded");
    expect(rows.filter((r) => r.status !== "PASS")).toEqual([]);
    expect(rows).toHaveLength(23);
    const find = (part: string) => rows.find((r) => r.check.includes(part));
    expect(find("deployed code hash")?.actual).toBe("ACFe6Us2mTm8ms2VYgC1PTG4VrMmMHzNhT99tcxk2sq");
    expect(find("refusal journey, 18 transactions")?.actual).toContain("all 18 as recorded");
    for (const code of [
      "STALE_REVISION",
      "FORBIDDEN",
      "NONCE_REPLAYED",
      "DESTINATION_MISMATCH",
      "HOLD_ACTIVE",
      "SIGNATURE_INVALID",
    ]) {
      expect(rows.some((r) => r.check.includes("refused") && r.actual.startsWith(code))).toBe(true);
    }
    expect(find("balance of the supplier")?.actual).toBe("15 USDC");
    expect(find("balance of the escrow3")?.actual).toBe("0 USDC");
    expect(find("ledger (refund)")?.actual).toBe("funded 5 USDC, refunded 5 USDC, conserved");
  });

  it("fails when the account runs other code", async () => {
    const { rows } = await run("code-hash");
    expect(rows.find((r) => r.check.includes("deployed code hash"))?.status).toBe("FAIL");
  });

  it("fails a ledger whose buckets no longer conserve the funded value", async () => {
    const { rows } = await run("ledger");
    const ledgers = rows.filter((r) => r.check.includes(" ledger ("));
    expect(ledgers).toHaveLength(4);
    expect(ledgers.every((r) => r.status === "FAIL")).toBe(true);
  });

  it("fails a refusal with another code than recorded", async () => {
    const { rows } = await run("refusal-code");
    const r = rows.find((x) => x.check.includes("refused replayed nonce"));
    expect(r?.status).toBe("FAIL");
    expect(r?.actual).toBe("FORBIDDEN (escrow receipt fails)");
    expect(rows.filter((x) => x.status === "FAIL")).toHaveLength(1);
  });

  it("fails every journey whose payout went to another receiver", async () => {
    const { rows } = await run("ft-recipient");
    const failed = rows.filter((r) => r.status === "FAIL").map((r) => r.check);
    expect(failed).toHaveLength(4);
    expect(failed.every((c) => c.includes("journey"))).toBe(true);
  });

  it("fails a journey whose payout transaction failed", async () => {
    const { rows } = await run("tx-failed");
    expect(rows.filter((r) => r.status === "FAIL" && r.check.includes("journey")).length).toBeGreaterThan(0);
  });

  it("reports ERROR, never PASS, when the transactions cannot be read", async () => {
    const { rows } = await run("tx-unknown");
    const txRows = rows.filter((r) => r.check.includes(" tx:") || r.check.includes("journey"));
    expect(txRows.length).toBe(13);
    expect(txRows.every((r) => r.status === "ERROR")).toBe(true);
  });

  it("reads the refusal code of a failed escrow receipt", () => {
    const failure = (msg: string) => ({
      Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: msg } } } },
    });
    expect(panicCode(failure("Smart contract panicked: DOCKSIDE:HOLD_ACTIVE: a hold is active"))).toBe(
      "HOLD_ACTIVE",
    );
    expect(panicCode(failure("Exceeded the prepaid gas."))).toBeNull();
    expect(panicCode({ SuccessValue: "" })).toBeNull();
  });
});
