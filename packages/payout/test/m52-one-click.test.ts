/**
 * M52 supplier cash-out, package level: the read-only 1Click client against the local simulator
 * (packages/payout/test/fixtures), the check of the supplier's own real quote, the deposit call and
 * the reconciliation rule. SIMULATED: the 1Click service. No request leaves this machine.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildQuoteRequest,
  CASH_OUT_STATES,
  type CashOutParams,
  checkRealQuote,
  type DepositObservation,
  depositCall,
  MIN_DEPOSIT_WINDOW_MS,
  nep141Contract,
  OneClickClient,
  type OneClickStatus,
  type ProviderObservation,
  quoteCost,
  reconcileCashOut,
} from "../src/index.js";
import { OneClickSimulator } from "./fixtures/one-click-simulator.js";

const NOW = Date.parse("2026-11-13T10:00:00.000Z");
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const params: CashOutParams = {
  supplierAccountId: "harbor-supplier.testnet",
  originAsset: "nep141:sim-usd.testnet",
  destinationAsset: ARB_USDC,
  amount: "2000000",
  recipient: "0x1111111111111111111111111111111111111111",
  slippageBps: 100,
  deadlineMs: NOW + 30 * 60_000,
};
const dryParams = (over: Partial<CashOutParams> = {}) => {
  const { dry: _dry, ...p } = buildQuoteRequest({ ...params, ...over }, true);
  return p;
};

describe("M52 1Click client against the local simulator", () => {
  const sim = new OneClickSimulator(undefined, () => NOW);
  let client: OneClickClient;
  let url = "";

  beforeAll(async () => {
    url = await sim.start();
    client = new OneClickClient({ baseUrl: url, timeoutMs: 400 });
  });
  afterAll(() => sim.stop());
  beforeEach(() => {
    sim.fault = "none";
    sim.requests.length = 0;
  });

  it("lists tokens in the published shape", async () => {
    const r = await client.tokens();
    expect(r.kind).toBe("OK");
    if (r.kind !== "OK") return;
    expect(r.value.map((t) => t.blockchain)).toEqual(["near", "arb", "base", "eth"]);
    expect(r.value[0]).toMatchObject({ assetId: "nep141:sim-usd.testnet", decimals: 6, symbol: "SIMUSD" });
  });

  it("a dry quote sends dry:true, returns amount out and no deposit address, and commits nothing", async () => {
    const r = await client.dryQuote(dryParams());
    expect(r.kind).toBe("OK");
    if (r.kind !== "OK") return;
    // 2 SIMUSD in; 30 bps fee and a 0.05 USDC withdrawal fee out.
    expect(r.value.quote.amountIn).toBe("2000000");
    expect(r.value.quote.amountOut).toBe("1944000");
    expect(r.value.quote.minAmountOut).toBe("1924560");
    expect(r.value.quote.depositAddress).toBeNull();
    expect(quoteCost(r.value.quote)).toEqual({ usd: "0.056", bps: 280 });
    expect(sim.requests).toHaveLength(1);
    expect(sim.requests[0]?.body?.["dry"]).toBe(true);
    expect(sim.swaps.size).toBe(0);
  });

  it("the client cannot be made to send dry:false", async () => {
    const forced = { ...buildQuoteRequest(params, false) } as never;
    const r = await client.dryQuote(forced);
    expect(r.kind).toBe("OK");
    expect(sim.requests.every((q) => q.body?.["dry"] === true)).toBe(true);
    expect(sim.swaps.size).toBe(0);
    expect(Object.getOwnPropertyNames(OneClickClient.prototype).sort()).toEqual([
      "constructor",
      "dryQuote",
      "read",
      "status",
      "tokens",
    ]);
  });

  it("sends the partner token as a bearer header only when one is configured", async () => {
    await client.dryQuote(dryParams());
    await new OneClickClient({ baseUrl: url, bearer: "test-partner-token" }).dryQuote(dryParams());
    expect(sim.requests.map((q) => q.authorization)).toEqual([null, "Bearer test-partner-token"]);
  });

  it("a refusal by the provider is an HTTP_ERROR with the provider's own message", async () => {
    expect(await client.dryQuote(dryParams({ destinationAsset: "nep141:nope.near" }))).toEqual({
      kind: "HTTP_ERROR",
      status: 400,
      message: "tokenOut is not valid",
    });
  });

  it("no answer, an error answer and a wrong-shaped answer are never read as a quote or a status", async () => {
    sim.fault = "hang";
    expect(await client.dryQuote(dryParams())).toEqual({ kind: "TIMEOUT" });
    expect(await client.status("a".repeat(64))).toEqual({ kind: "TIMEOUT" });
    sim.fault = "http500";
    expect((await client.dryQuote(dryParams())).kind).toBe("HTTP_ERROR");
    sim.fault = "garbage";
    expect(await client.status("a".repeat(64))).toEqual({
      kind: "AMBIGUOUS",
      detail: "response is not JSON",
    });
    sim.fault = "wrong-shape";
    expect((await client.dryQuote(dryParams())).kind).toBe("AMBIGUOUS");
    expect((await client.status("a".repeat(64))).kind).toBe("AMBIGUOUS");
    expect((await client.tokens()).kind).toBe("AMBIGUOUS");
  });

  it("a stopped provider is a TRANSPORT_ERROR", async () => {
    const dead = new OneClickSimulator();
    const deadUrl = await dead.start();
    await dead.stop();
    const r = await new OneClickClient({ baseUrl: deadUrl, timeoutMs: 2_000 }).tokens();
    expect(r.kind).toBe("TRANSPORT_ERROR");
  });

  it("a dry answer that names a deposit address is refused as AMBIGUOUS", async () => {
    const lying = new OneClickClient({
      baseUrl: url,
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const real = await fetch(input, { ...init, body: JSON.stringify({ ...body, dry: false }) });
        const j = (await real.json()) as { quoteRequest: Record<string, unknown> };
        j.quoteRequest["dry"] = true;
        return new Response(JSON.stringify(j), { status: 201 });
      },
    });
    expect(await lying.dryQuote(dryParams())).toEqual({
      kind: "AMBIGUOUS",
      detail: "a dry quote answered with a deposit address",
    });
  });

  it("reads the status of the supplier's own quote through every documented status", async () => {
    const real = await fetch(`${url}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildQuoteRequest(params, false)),
    });
    const quote = (await real.json()) as { quote: { depositAddress: string } };
    const addr = quote.quote.depositAddress;
    const read = async () => {
      const r = await client.status(addr);
      if (r.kind !== "OK") throw new Error(r.kind);
      return r.value;
    };
    expect((await read()).status).toBe("PENDING_DEPOSIT");
    expect((await read()).quoteRequest.refundTo).toBe("harbor-supplier.testnet");
    sim.observeDeposit(addr, "1000000");
    expect((await read()).status).toBe("INCOMPLETE_DEPOSIT");
    sim.observeDeposit(addr, "2000000", "DepositTxHash111");
    expect(await read()).toMatchObject({
      status: "PROCESSING",
      swapDetails: { depositedAmount: "2000000", originChainTxHashes: [{ hash: "DepositTxHash111" }] },
    });
    sim.settle(addr, "0xdest");
    expect(await read()).toMatchObject({
      status: "SUCCESS",
      swapDetails: { amountOut: "1944000", destinationChainTxHashes: [{ hash: "0xdest" }] },
    });
    sim.refund(addr, "DEADLINE_PASSED");
    expect((await read()).swapDetails).toMatchObject({
      refundedAmount: "2000000",
      refundReason: "DEADLINE_PASSED",
    });
    expect(await client.status("b".repeat(64))).toMatchObject({ kind: "HTTP_ERROR", status: 404 });
  });

  it("refuses a base URL with a path, query or credentials", () => {
    for (const bad of ["https://host/v0", "https://host/?x=1", "https://user:pw@host"])
      expect(() => new OneClickClient({ baseUrl: bad })).toThrow();
  });
});

describe("M52 the supplier's real quote is checked field by field", () => {
  const sim = new OneClickSimulator(undefined, () => NOW);
  let url = "";
  const expected = buildQuoteRequest(params, false);
  const realQuote = async (over: Record<string, unknown> = {}) => {
    const r = await fetch(`${url}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...expected, ...over }),
    });
    return (await r.json()) as { quoteRequest: Record<string, unknown>; quote: Record<string, unknown> };
  };
  beforeAll(async () => {
    url = await sim.start();
  });
  afterAll(() => sim.stop());

  it("accepts the answer to exactly the previewed request", async () => {
    const q = await realQuote();
    expect(checkRealQuote(expected, q, NOW)).toEqual({
      ok: true,
      quote: {
        depositAddress: q.quote["depositAddress"],
        amountIn: "2000000",
        amountOut: "1944000",
        minAmountOut: "1924560",
        amountOutFormatted: "1.944",
        depositBeforeMs: params.deadlineMs,
        correlationId: expect.stringMatching(/^sim-quote-/),
      },
    });
  });

  it("names every field that differs from what was previewed", async () => {
    const cases: [Record<string, unknown>, string[]][] = [
      [{ recipient: "0x2222222222222222222222222222222222222222" }, ["recipient"]],
      [{ refundTo: "attacker.testnet" }, ["refundTo"]],
      [{ amount: "2000001" }, ["amount", "amountIn"]],
      [{ destinationAsset: BASE_USDC }, ["destinationAsset"]],
      [{ slippageTolerance: 5000 }, ["slippageTolerance"]],
      [{ deadline: new Date(params.deadlineMs + 1000).toISOString() }, ["deadline"]],
      [{ dry: true }, ["dry", "depositAddress"]],
    ];
    for (const [over, fields] of cases) {
      const r = checkRealQuote(expected, await realQuote(over), NOW);
      expect(r, JSON.stringify(over)).toEqual({ ok: false, mismatches: fields });
    }
  });

  it("refuses a tampered deposit address, a memo, a bad minimum, an expired quote and junk", async () => {
    const q = await realQuote();
    const withQuote = (over: Record<string, unknown>) => ({ ...q, quote: { ...q.quote, ...over } });
    const fields = (v: unknown, now = NOW) => {
      const r = checkRealQuote(expected, v, now);
      return r.ok ? [] : r.mismatches;
    };
    expect(fields(withQuote({ depositAddress: "Not A Near Account" }))).toEqual(["depositAddress"]);
    expect(fields(withQuote({ depositAddress: "harbor-supplier.testnet" }))).toEqual(["depositAddress"]);
    expect(fields(withQuote({ depositMemo: "12345" }))).toEqual(["depositMemo"]);
    expect(fields(withQuote({ minAmountOut: "0" }))).toEqual(["minAmountOut"]);
    expect(fields(withQuote({ minAmountOut: "1944001" }))).toEqual(["minAmountOut"]);
    expect(fields(q, params.deadlineMs - MIN_DEPOSIT_WINDOW_MS + 1)).toEqual(["deadline_passed"]);
    expect(fields(withQuote({ timeWhenInactive: new Date(NOW + 1000).toISOString() }))).toEqual([
      "deadline_passed",
    ]);
    expect(fields("{}")[0]).toMatch(/^undecodable/);
    expect(fields({ quote: {} })[0]).toMatch(/^undecodable/);
    expect(fields(withQuote({ amountOut: 1944000 }))[0]).toMatch(/^undecodable/);
    // The check refuses to treat a dry request as the expectation.
    expect(checkRealQuote(buildQuoteRequest(params, true), q, NOW).ok).toBe(false);
  });

  it("builds the deposit as one ft_transfer of the exact amount with one yoctoNEAR", () => {
    expect(nep141Contract("nep141:sim-usd.testnet")).toBe("sim-usd.testnet");
    expect(
      nep141Contract("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toHaveLength(64);
    for (const bad of ["sim-usd.testnet", "nep245:v2.omni:1", "nep141:UPPER.near", "nep141:a..b", "nep141:x"])
      expect(nep141Contract(bad), bad).toBeNull();
    expect(depositCall("sim-usd.testnet", "c".repeat(64), "2000000")).toEqual({
      receiverId: "sim-usd.testnet",
      methodName: "ft_transfer",
      args: { receiver_id: "c".repeat(64), amount: "2000000" },
      gas: "30000000000000",
      depositYocto: "1",
    });
  });
});

describe("M52 reconciliation never turns doubt into a resend", () => {
  const open = NOW + 10 * 60_000;
  const status = (s: OneClickStatus): ProviderObservation => ({ kind: "STATUS", status: s });
  const run = (
    provider: ProviderObservation,
    deposit: DepositObservation,
    depositBeforeMs: number | null = open,
  ) => reconcileCashOut({ provider, deposit, nowMs: NOW, depositBeforeMs });
  const deposits: DepositObservation[] = [
    { kind: "NOT_PROVIDED" },
    { kind: "CONFIRMED" },
    { kind: "FUNDS_AT_ADDRESS" },
    { kind: "FAILED_NO_TRANSFER" },
    { kind: "EXECUTING" },
    { kind: "NOT_FOUND" },
    { kind: "DIFFERENT_TRANSACTION" },
    { kind: "UNREADABLE", why: "timeout" },
  ];
  const providers: ProviderObservation[] = [
    ...(
      [
        "KNOWN_DEPOSIT_TX",
        "PENDING_DEPOSIT",
        "INCOMPLETE_DEPOSIT",
        "PROCESSING",
        "SUCCESS",
        "REFUNDED",
        "FAILED",
      ] as const
    ).map(status),
    { kind: "UNKNOWN_ADDRESS" },
    { kind: "UNREADABLE", why: "timeout" },
  ];

  it("allows a deposit in exactly two cells of the whole matrix", () => {
    const allowed: string[] = [];
    for (const p of providers)
      for (const d of deposits) {
        const r = run(p, d);
        expect(CASH_OUT_STATES).toContain(r.state);
        if (r.maySendDeposit) allowed.push(`${p.kind === "STATUS" ? p.status : p.kind}/${d.kind}`);
      }
    expect(allowed).toEqual(["PENDING_DEPOSIT/NOT_PROVIDED", "PENDING_DEPOSIT/FAILED_NO_TRANSFER"]);
  });

  it("an unreadable or unknown provider answer is UNKNOWN whatever the chain says", () => {
    for (const d of deposits) {
      expect(run({ kind: "UNREADABLE", why: "timeout" }, d)).toMatchObject({
        state: "UNKNOWN",
        maySendDeposit: false,
        terminal: false,
      });
      expect(run({ kind: "UNKNOWN_ADDRESS" }, d)).toMatchObject({ state: "UNKNOWN", maySendDeposit: false });
    }
  });

  it("maps each provider status, and each chain reading while the provider still waits", () => {
    const none: DepositObservation = { kind: "NOT_PROVIDED" };
    expect(run(status("SUCCESS"), none)).toMatchObject({ state: "DELIVERED", terminal: true });
    expect(run(status("REFUNDED"), none)).toMatchObject({ state: "REFUNDED", terminal: true });
    expect(run(status("FAILED"), none)).toMatchObject({ state: "FAILED", terminal: true });
    expect(run(status("INCOMPLETE_DEPOSIT"), none).state).toBe("INCOMPLETE_DEPOSIT");
    expect(run(status("PROCESSING"), none).state).toBe("IN_PROGRESS");
    expect(run(status("KNOWN_DEPOSIT_TX"), none).state).toBe("IN_PROGRESS");
    const pending = status("PENDING_DEPOSIT");
    expect(run(pending, none).state).toBe("AWAITING_DEPOSIT");
    expect(run(pending, { kind: "CONFIRMED" }).state).toBe("DEPOSIT_SENT_WAITING_FOR_PROVIDER");
    expect(run(pending, { kind: "FUNDS_AT_ADDRESS" }).state).toBe("DEPOSIT_SENT_WAITING_FOR_PROVIDER");
    expect(run(pending, { kind: "FAILED_NO_TRANSFER" }).state).toBe("DEPOSIT_FAILED_NO_TRANSFER");
    for (const kind of ["EXECUTING", "NOT_FOUND", "DIFFERENT_TRANSACTION"] as const)
      expect(run(pending, { kind })).toMatchObject({ state: "UNKNOWN", maySendDeposit: false });
    expect(run(pending, { kind: "UNREADABLE", why: "rpc" }).reason).toContain(
      "Do not send the deposit again",
    );
  });

  it("a closed or unknown deposit window never allows a deposit", () => {
    const pending = status("PENDING_DEPOSIT");
    for (const before of [NOW + MIN_DEPOSIT_WINDOW_MS - 1, NOW - 1, null]) {
      expect(run(pending, { kind: "NOT_PROVIDED" }, before)).toMatchObject({
        state: "QUOTE_EXPIRED",
        maySendDeposit: false,
      });
      expect(run(pending, { kind: "FAILED_NO_TRANSFER" }, before)).toMatchObject({
        state: "QUOTE_EXPIRED",
        maySendDeposit: false,
        terminal: true,
      });
    }
    expect(run(pending, { kind: "NOT_PROVIDED" }, NOW + MIN_DEPOSIT_WINDOW_MS).maySendDeposit).toBe(true);
  });
});
