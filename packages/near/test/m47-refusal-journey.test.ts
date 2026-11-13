/**
 * M47: run-all `--journey refusal` (scripts/testnet-deploy). Six calls the escrow must reject,
 * each sent as a real transaction, then the trade completes normally.
 *
 * The journey runs with real transactions on a local near-sandbox node in
 * contract/integration/sandbox-tests/tests/run_all_on_sandbox.rs (container only). This file
 * checks the driver without a chain: the plan, the option guards, the parsing of a failed
 * receipt, and the whole driver against a stand-in chain. The stand-in executes every call with
 * the real `dockside-escrow-core` code (a second `dockside-journey-mirror` process, the binary
 * run-all builds), so each refusal here is the core's own decision, not a scripted answer; only
 * the transport (near-cli-rs, RPC, receipts, balances) is simulated.
 * IDs: T-006/T-015/T-019 (authority conjunction), T-016 (holds), T-020 (destination), T-007/T-008
 * (funding binding), T-009 (funder-only refund rows).
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOOL = join(ROOT, "scripts/testnet-deploy/tool.mjs");
const RUN_ALL = join(ROOT, "scripts/testnet-deploy/run-all");
const INTEGRATION = join(ROOT, "contract/integration");
const dir = mkdtempSync(join(tmpdir(), "dockside-m47-"));

type Json = Record<string, unknown>;
interface PlanStep {
  id: string;
  what?: string;
  kind?: string;
  expect?: string;
  replay?: string;
  as?: string;
}
interface Refusal {
  id: string;
  expect: string;
  method: string;
  title: string;
}
interface StepRecord {
  step: string;
  method?: string;
  signer?: string;
  txHash?: string;
  refused?: { expected: string; code: string; message: string; error: string };
  stateUnchanged?: boolean;
  viewsEqualCore?: boolean;
  depositYocto?: string;
  signerBeforeYocto?: string;
  signerAfterYocto?: string;
}
interface JourneyResult {
  ok: boolean;
  paused: boolean;
  why?: string;
  journey: string;
  tradeId: string;
  steps: StepRecord[];
  checks: Record<string, unknown> & { refusals: Json[] };
}
const j = (await import(pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib/journey.mjs")).href)) as {
  JOURNEYS: string[];
  REFUSALS: Refusal[];
  planMethods(journey: string): PlanStep[];
  contractRefusal(status: unknown): { code: string | null; message: string | null; error: string };
  runJourney(o: Json): Promise<JourneyResult>;
};

const t = (await import(pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib/near-tools.mjs")).href)) as {
  parseTxHash(text: string): string | null;
  looksLikePrompt(text: string): boolean;
  classifyNearFailure(text: string): { retry: boolean; kind: string };
  runNear(
    bin: string,
    args: string[],
    o: { run: () => Promise<{ status: number; text: string; txHash: string | null }> },
  ): Promise<{ status: number; txHash: string | null }>;
};

const ACCOUNTS = {
  escrow: "dockside-escrow.testnet",
  buyer: "acme-buyer.testnet",
  supplier: "harbor-supplier.testnet",
  relayer: "relayer.testnet",
};
const ENV = {
  DOCKSIDE_ESCROW_ACCOUNT: ACCOUNTS.escrow,
  DOCKSIDE_BUYER_ACCOUNT: ACCOUNTS.buyer,
  DOCKSIDE_SUPPLIER_ACCOUNT: ACCOUNTS.supplier,
  DOCKSIDE_RELAYER_ACCOUNT: ACCOUNTS.relayer,
};
const AMOUNT = 50_000_000_000_000_000_000_000n;
const NEAR = 10n ** 24n;
const FEE = 10n ** 20n;

const EXPECTED = [
  ["refuse:fund_wrong_terms", "fund", "STALE_REVISION"],
  ["refuse:relayer_refund", "request_refund", "FORBIDDEN"],
  ["refuse:replayed_nonce", "submit_inspection", "NONCE_REPLAYED"],
  ["refuse:payout_redirect", "create_release_intent", "DESTINATION_MISMATCH"],
  ["refuse:release_while_held", "execute_release", "HOLD_ACTIVE"],
  ["refuse:unbound_approval", "approve_release", "SIGNATURE_INVALID"],
];

describe("refusal journey plan", () => {
  it("is a journey run-all knows, next to paid, hold and refund", () => {
    expect(j.JOURNEYS).toEqual(["paid", "hold", "refund", "refusal"]);
  });

  it("names six refusals, each with the code the contract must answer", () => {
    expect(j.REFUSALS.map((r) => [r.id, r.method, r.expect])).toEqual(EXPECTED);
    for (const r of j.REFUSALS) expect(r.title.length).toBeGreaterThan(10);
  });

  it("places every refusal where only the refused thing is wrong, then completes the trade", () => {
    const plan = j.planMethods("refusal");
    expect(plan.map((s) => s.id)).toEqual([
      "register",
      "policy",
      "refuse:fund_wrong_terms",
      "fund:1",
      "refuse:relayer_refund",
      "fund:2",
      "attestation",
      "inspection",
      "refuse:replayed_nonce",
      "hold_set",
      "refuse:payout_redirect",
      "intent",
      "observe:held",
      "refuse:release_while_held",
      "hold_resolve",
      "refuse:unbound_approval",
      "approval",
      "execute_release",
    ]);
    const refuse = plan.filter((s) => s.kind === "refuse");
    expect(refuse.map((s) => [s.id, s.expect])).toEqual(EXPECTED.map(([id, , code]) => [id, code]));
    // The replay sends the accepted inspection again; the funder-only refund is sent by the relayer.
    expect(plan.find((s) => s.id === "refuse:replayed_nonce")?.replay).toBe("inspection");
    expect(plan.find((s) => s.id === "refuse:relayer_refund")?.as).toBe("relayer");
    // The other journeys are untouched.
    expect(j.planMethods("paid").some((s) => s.kind === "refuse")).toBe(false);
    expect(j.planMethods("hold").some((s) => s.kind === "refuse")).toBe(false);
    expect(j.planMethods("refund").some((s) => s.kind === "refuse")).toBe(false);
  });
});

describe("reading a failed receipt", () => {
  const failure = (text: string) => ({
    Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: text } } } },
  });
  it("takes the DOCKSIDE code and message from the contract panic", () => {
    const r = j.contractRefusal(
      failure("Smart contract panicked: DOCKSIDE:HOLD_ACTIVE: release conjunction incomplete: HOLD_ACTIVE"),
    );
    expect(r.code).toBe("HOLD_ACTIVE");
    expect(r.message).toBe("release conjunction incomplete: HOLD_ACTIVE");
    expect(r.error).toContain("Smart contract panicked");
  });
  it("reports no code for any other failure or a success", () => {
    expect(j.contractRefusal(failure("Exceeded the prepaid gas.")).code).toBeNull();
    expect(
      j.contractRefusal({ Failure: { ActionError: { kind: { AccountDoesNotExist: {} } } } }).code,
    ).toBeNull();
    expect(j.contractRefusal({ SuccessValue: "" }).code).toBeNull();
    expect(j.contractRefusal(undefined).code).toBeNull();
  });
});

describe("near-cli-rs output of a failed transaction", () => {
  // What near-cli-rs 0.31.1 printed (exit status 1) for a function call that failed on a
  // near-sandbox node, captured in the sandbox container; ESC stands for the escape character.
  const captured = [
    "ESC[31m├  ERROR Transaction failed",
    "│    Gas used: 1.7 Tgas",
    "│    Transaction fee: 0.0001196145831208 NEAR",
    "│    Transaction ID: FNUNXyVDcfohu2mmpeYGvKHxNPCKJCQ2qhXsjsdSxh4c",
    "│    To see the transaction in the transaction explorer, please open this url in your browser:",
    "│    http://127.0.0.1:9011/FNUNXyVDcfohu2mmpeYGvKHxNPCKJCQ2qhXsjsdSxh4c",
    "│     ESC[0m",
    "├  Function execution logs:",
    "│    ESC[31mLogs [test.near] (failed):ESC[39m   ESC[2mNo logsESC[0m",
    "│     ESC[0m",
    "",
    "Error: ",
    "   0: ESC[91mError: An error occurred during a `FunctionCall` action.",
    '      CompilationError(CodeDoesNotExist { account_id: AccountId("test.near") })ESC[0m',
    "",
  ]
    .join("\n")
    .replaceAll("ESC", String.fromCharCode(27));

  it("carries the transaction id, is not a question, and is never signed again", async () => {
    expect(t.parseTxHash(captured)).toBe("FNUNXyVDcfohu2mmpeYGvKHxNPCKJCQ2qhXsjsdSxh4c");
    expect(t.looksLikePrompt(captured)).toBe(false);
    expect(t.classifyNearFailure(captured)).toMatchObject({ retry: false, kind: "SENT" });
    let runs = 0;
    const r = await t.runNear("near", ["x"], {
      run: async () => {
        runs++;
        return { status: 1, text: captured, txHash: t.parseTxHash(captured) };
      },
    });
    expect([runs, r.status, r.txHash]).toEqual([1, 1, "FNUNXyVDcfohu2mmpeYGvKHxNPCKJCQ2qhXsjsdSxh4c"]);
  });
});

function tool(args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...ENV },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("run-all wiring", () => {
  const script = readFileSync(RUN_ALL, "utf8");
  it("accepts --journey refusal and documents it", () => {
    expect(script).toMatch(/paid\|hold\|refund\|refusal\) ;;/);
    expect(script).toMatch(/--journey <paid\|hold\|refund\|refusal>/);
    expect(script).toMatch(/refusal\s+six calls the contract must reject/);
  });
  it("records which transactions were refused and with which code", () => {
    expect(script).toMatch(/refused: s\.refused\.code/);
  });
  it("still refuses an unknown journey before any RPC call", () => {
    const r = tool([
      "journey",
      "--network",
      "sandbox",
      "--rpc-url",
      "http://127.0.0.1:9",
      "--out",
      dir,
      "--journey",
      "refuse",
      "--amount-yocto",
      "1",
    ]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/--journey must be one of paid, hold, refund, refusal/);
    expect(r.err).not.toContain("RPC_UNAVAILABLE");
  });
});

/* ------------------------- the driver against a stand-in chain ------------------------- */

const MIRROR = join(
  INTEGRATION,
  "target/release",
  `dockside-journey-mirror${process.platform === "win32" ? ".exe" : ""}`,
);

class CoreProcess {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncIterator<string>;
  constructor() {
    this.child = spawn(MIRROR, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
  }
  async send(req: Json): Promise<Json> {
    this.child.stdin.write(`${JSON.stringify(req)}\n`);
    const { value } = await this.lines.next();
    return JSON.parse(value as string) as Json;
  }
  close() {
    this.child.stdin.end();
  }
}

interface Tx {
  method: string;
  signer: string;
  args: unknown;
  ok: boolean;
}
type Tamper = (tx: Tx, n: number) => "accept" | "other-code" | "lose-id" | undefined;

/**
 * near-cli-rs and the RPC of a chain whose escrow runs the real core. A failed call returns its
 * attached deposit to the signer and costs it a fee, like the runtime does.
 */
class StandInChain {
  core = new CoreProcess();
  time = 1_800_000_000_000;
  blocks = new Map<string, number>();
  txs = new Map<string, Json>();
  sent: (Tx & { hash: string })[] = [];
  balances = new Map<string, bigint>([
    [ACCOUNTS.escrow, 10n * NEAR],
    [ACCOUNTS.buyer, 10n * NEAR],
    [ACCOUNTS.supplier, 10n * NEAR],
    [ACCOUNTS.relayer, 10n * NEAR],
  ]);
  tamper: Tamper = () => undefined;

  async start() {
    const r = await this.core.send({
      op: "init",
      accounts: { contract: ACCOUNTS.escrow, buyer: ACCOUNTS.buyer, supplier: ACCOUNTS.supplier },
      seed: "c4".repeat(32),
      trade: "chain",
      amountYocto: "1",
      delayMs: 3_600_000,
      t0: this.time,
    });
    expect(r.ok).toBe(true);
    return this;
  }

  private block() {
    this.time += 1_100;
    const hash = `block-${this.blocks.size + 1}`;
    this.blocks.set(hash, this.time);
    return hash;
  }
  private pay(account: string, delta: bigint) {
    this.balances.set(account, (this.balances.get(account) ?? 0n) + delta);
  }
  private receipt(executor: string, block: string, status: Json) {
    return { block_hash: block, outcome: { executor_id: executor, status } };
  }
  private static value(v: unknown) {
    return { SuccessValue: Buffer.from(v === undefined ? "" : JSON.stringify(v)).toString("base64") };
  }

  rpc = {
    blockTimeMs: async (hash?: string) => {
      if (hash) return this.blocks.get(hash) as number;
      this.time += 400;
      return this.time;
    },
    view: async (_contract: string, method: string, args: Json) => {
      const r = await this.core.send({ op: "view", method, args, now: this.time });
      if (!r.ok) throw new Error(`view ${method}: ${String(r.code)}`);
      return r.value;
    },
    viewAccount: async (id: string) => ({ amount: (this.balances.get(id) ?? 0n).toString() }),
    txStatus: async (hash: string) => {
      const tx = this.txs.get(hash);
      if (!tx) throw new Error(`UNKNOWN_TRANSACTION ${hash}`);
      return tx;
    },
  };

  /** `near contract call-function as-transaction <escrow> <method> file-args <file> ... send`. */
  near = async (argv: string[]) => {
    const [, , , escrow, method, , file, , , , depositText, , signer] = argv as string[];
    expect(escrow).toBe(ACCOUNTS.escrow);
    const args = JSON.parse(readFileSync(file as string, "utf8")) as Json;
    const deposit = BigInt((depositText as string).split(" ")[0] as string);
    const n = this.sent.length;
    const hash = createHash("sha256").update(`${n}/${method}/${signer}`).digest("hex").slice(0, 44);
    const block = this.block();
    const call = { method, args, now: this.time, predecessor: signer, deposit: deposit.toString() };
    const probe = await this.core.send({ op: "probe", ...call });
    const tx: Tx = { method: method as string, signer: signer as string, args, ok: probe.ok === true };
    const how = this.tamper(tx, n);
    this.sent.push({ ...tx, hash });
    this.pay(signer as string, -FEE);
    const receipts: Json[] = [];
    let failed = false;
    if (how === "accept") {
      // A chain that wrongly accepts: nothing is applied, the receipt reports success.
      receipts.push(this.receipt(escrow as string, block, StandInChain.value("accepted")));
    } else if (!tx.ok) {
      failed = true;
      const code = how === "other-code" ? "VALIDATION_FAILED" : String(probe.code);
      const text = `Smart contract panicked: DOCKSIDE:${code}: ${String(probe.message)}`;
      receipts.push(
        this.receipt(escrow as string, block, {
          Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: text } } } },
        }),
      );
      // The runtime returns the attached deposit of a failed call to its sender.
      if (deposit > 0n)
        receipts.push(this.receipt(signer as string, this.block(), StandInChain.value(undefined)));
    } else {
      const applied = await this.core.send({ op: "apply", ...call });
      expect(applied.ok).toBe(true);
      this.pay(signer as string, -deposit);
      this.pay(escrow as string, deposit);
      const value = applied.value as { transfer?: { to: string; amount: string }; attempt_id?: string };
      if (method === "execute_release" && value.transfer) {
        receipts.push(this.receipt(escrow as string, block, { SuccessReceiptId: "next" }));
        const { to, amount } = value.transfer;
        this.pay(escrow as string, -BigInt(amount));
        this.pay(to, BigInt(amount));
        receipts.push(this.receipt(to, this.block(), StandInChain.value(undefined)));
        const settleBlock = this.block();
        const settled = await this.core.send({
          op: "apply",
          method: "on_release_transfer",
          args: {
            trade_id: args.trade_id,
            release_intent_id: args.release_intent_id,
            attempt_id: value.attempt_id,
          },
          now: this.time,
          predecessor: escrow,
          deposit: "0",
          promiseOk: true,
        });
        expect(settled.ok).toBe(true);
        receipts.push(this.receipt(escrow as string, settleBlock, StandInChain.value(settled.value)));
      } else {
        receipts.push(this.receipt(escrow as string, block, StandInChain.value(applied.value)));
      }
    }
    this.txs.set(hash, {
      status: failed ? (receipts[0] as { outcome: { status: Json } }).outcome.status : { SuccessValue: "" },
      transaction: {
        signer_id: signer,
        receiver_id: escrow,
        actions: [
          {
            FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64") },
          },
        ],
      },
      receipts_outcome: receipts,
    });
    if (how === "lose-id") {
      const text = "Error: near-cli-rs timeout: no result within 300000 ms";
      return { status: 1, text, clean: text, txHash: null };
    }
    const text = `${failed ? "ERROR Transaction failed" : "Transaction Execution Info:"}\n  Transaction ID: ${hash}\n`;
    return { status: failed ? 1 : 0, text, clean: text, txHash: hash };
  };
}

async function run(chain: StandInChain, outDir: string, extra: Json = {}) {
  const log: string[] = [];
  const result = await j.runJourney({
    journey: "refusal",
    resume: false,
    wait: true,
    rpc: chain.rpc,
    profile: { network: "sandbox", cliNetwork: "sandbox" },
    accounts: ACCOUNTS,
    near: chain.near,
    relayerKeyFile: join(dir, "relayer-key.json"),
    mirrorBin: MIRROR,
    outDir,
    amountYocto: AMOUNT,
    minDepositYocto: "1000000000000000000000",
    log: (m: string) => log.push(m),
    ...extra,
  });
  return { result, log };
}

describe("refusal journey driver (the core decides, the transport is a stand-in)", () => {
  const chains: StandInChain[] = [];
  const chain = async () => {
    const c = await new StandInChain().start();
    chains.push(c);
    return c;
  };
  beforeAll(() => {
    const cargo = process.env.CARGO ?? "cargo";
    const r = spawnSync(
      cargo,
      [
        "build",
        "--quiet",
        "--locked",
        "--release",
        "-p",
        "dockside-fixtures",
        "--bin",
        "dockside-journey-mirror",
      ],
      { cwd: INTEGRATION, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(MIRROR)).toBe(true);
  }, 900_000);
  afterAll(() => {
    for (const c of chains) c.core.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends six calls that are refused with the expected codes, changes nothing, then gets PAID", async () => {
    const c = await chain();
    const out = mkdtempSync(join(dir, "full-"));
    const { result } = await run(c, out);
    expect(result.paused).toBe(false);
    expect(result.checks).toMatchObject({
      allRefusedWithExpectedCode: true,
      refusalsChangedNothing: true,
      refusedDepositReturned: true,
      relayerReceivedNothing: true,
      holdWasActive: true,
      releaseBlockedByHold: true,
      holdResolved: true,
      settledTrue: true,
      releasePaid: true,
      supplierReceivedExactAmount: true,
      supplierTotalDeltaYocto: AMOUNT.toString(),
      ledgerConservation: true,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.refusals.map((r) => [r.step, r.method, r.code])).toEqual(EXPECTED);

    // Seventeen transactions reached the chain; exactly the six planned ones failed there.
    expect(c.sent).toHaveLength(17);
    expect(c.sent.filter((t) => !t.ok).map((t) => t.method)).toEqual(EXPECTED.map(([, m]) => m));
    const refused = result.steps.filter((s) => s.refused);
    for (const s of refused) {
      expect(s.txHash).toBe(c.sent.find((t) => t.hash === s.txHash && !t.ok)?.hash);
      expect(s.stateUnchanged).toBe(true);
      expect(s.viewsEqualCore).toBe(true);
      expect(s.refused?.error).toContain(`DOCKSIDE:${s.refused?.code}: `);
    }
    // Who sent what: the buyer's own account sends the funding calls, the relayer everything else,
    // including the funder-only refund request it has no right to make.
    const bySigner = (m: string) => c.sent.filter((t) => t.method === m).map((t) => t.signer);
    expect(bySigner("fund")).toEqual([ACCOUNTS.buyer, ACCOUNTS.buyer, ACCOUNTS.buyer]);
    expect(bySigner("request_refund")).toEqual([ACCOUNTS.relayer]);
    // The refused deposit came back: the buyer is out the trade amount and fees, nothing more.
    const wrongFund = refused[0] as StepRecord;
    expect(wrongFund.depositYocto).toBe((AMOUNT / 2n).toString());
    expect(BigInt(wrongFund.signerBeforeYocto as string) - BigInt(wrongFund.signerAfterYocto as string)).toBe(
      FEE,
    );
    expect(c.balances.get(ACCOUNTS.supplier)).toBe(10n * NEAR + AMOUNT);
    expect(c.balances.get(ACCOUNTS.escrow)).toBe(10n * NEAR);
    // The replay is the accepted inspection, byte for byte.
    const inspections = c.sent.filter((t) => t.method === "submit_inspection");
    expect(inspections.map((t) => t.ok)).toEqual([true, false]);
    expect(inspections[1]?.args).toEqual(inspections[0]?.args);
    // The redirected intent names the relayer; the accepted one names the supplier.
    const dest = (t: Tx) =>
      (t.args as { payload: { struct: { destination: { str: string } } } }).payload.struct.destination.str;
    const intents = c.sent.filter((t) => t.method === "create_release_intent");
    expect(intents.map((t) => [t.ok, dest(t)])).toEqual([
      [false, ACCOUNTS.relayer],
      [true, ACCOUNTS.supplier],
    ]);
  });

  it("stops and reports when the chain accepts a call that must be refused", async () => {
    const c = await chain();
    c.tamper = (tx) => (tx.method === "request_refund" ? "accept" : undefined);
    await expect(run(c, mkdtempSync(join(dir, "accept-")))).rejects.toMatchObject({
      code: "REFUSAL_ACCEPTED",
    });
    expect(c.sent.at(-1)?.method).toBe("request_refund");
  });

  it("stops when the chain refuses with another code than the expected one", async () => {
    const c = await chain();
    c.tamper = (tx) => (tx.method === "fund" && !tx.ok ? "other-code" : undefined);
    await expect(run(c, mkdtempSync(join(dir, "code-")))).rejects.toMatchObject({
      code: "REFUSAL_MISMATCH",
      message: expect.stringMatching(/expected STALE_REVISION.*VALIDATION_FAILED/s),
    });
    expect(c.sent).toHaveLength(3);
  });

  it("pauses with --stop-after and finishes with resume, counting refused transactions", async () => {
    const c = await chain();
    const out = mkdtempSync(join(dir, "resume-"));
    const first = await run(c, out, { stopAfter: 9 });
    expect(first.result.paused).toBe(true);
    expect(c.sent).toHaveLength(9);
    expect(c.sent.filter((t) => !t.ok)).toHaveLength(3);
    const second = await run(c, out, { resume: true, journey: undefined, amountYocto: undefined });
    expect(second.result.ok).toBe(true);
    expect(second.result.checks.refusals.map((r) => r.code)).toEqual(EXPECTED.map(([, , code]) => code));
    expect(c.sent).toHaveLength(17);
  });

  it("settles a refused call whose transaction id was lost from the chain, not by sending it twice", async () => {
    const c = await chain();
    const out = mkdtempSync(join(dir, "lost-"));
    c.tamper = (tx) => (tx.method === "execute_release" && !tx.ok ? "lose-id" : undefined);
    await expect(run(c, out)).rejects.toMatchObject({ code: "SUBMIT_FAILED" });
    const lost = c.sent.at(-1) as Tx & { hash: string };
    expect(lost.method).toBe("execute_release");
    c.tamper = () => undefined;
    const resume = { resume: true, journey: undefined, amountYocto: undefined };
    await expect(run(c, out, resume)).rejects.toMatchObject({ code: "PENDING_UNKNOWN" });
    // Another transaction's id is not accepted for the call in flight.
    const other = c.sent.find((t) => t.method === "set_hold") as Tx & { hash: string };
    await expect(run(c, out, { ...resume, pendingTx: other.hash })).rejects.toMatchObject({
      code: "PENDING_MISMATCH",
    });
    const done = await run(c, out, { ...resume, pendingTx: lost.hash });
    expect(done.result.ok).toBe(true);
    expect(c.sent.filter((t) => t.method === "execute_release").map((t) => t.ok)).toEqual([false, true]);
    expect(done.result.steps.find((s) => s.step === "refuse:release_while_held")?.txHash).toBe(lost.hash);
  });

  it("refuses an amount whose half is below the contract's minimum deposit, before any call", async () => {
    const c = await chain();
    await expect(
      run(c, mkdtempSync(join(dir, "small-")), { amountYocto: 1_500_000_000_000_000_000_000n }),
    ).rejects.toMatchObject({ code: "USAGE", message: expect.stringMatching(/two deposits/) });
    expect(c.sent).toHaveLength(0);
  });
});
