/**
 * M52 supplier cash-out routes ("Move to another chain").
 *
 * Real HTTP with PoP sessions and request proofs, the production read-only 1Click client against
 * the local 1Click simulator (packages/payout/test/fixtures), and the production JSON-RPC client
 * against the simulated NEAR chain with a simulated NEP-141 token. The supplier's "own client" is
 * this test: it sends the real quote request straight to the simulator and signs the deposit as
 * the supplier's account on the simulated chain; the API never does either.
 * SIMULATED: 1Click, the chain and the token. Nothing here touches testnet, mainnet or 1Click.
 */
import type { TxOutcome } from "@dockside/near";
import { type FunctionCall, NearTxClient, Nep141Reader } from "@dockside/near";
import { OneClickClient } from "@dockside/payout";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/authority/test/helpers.js";
import { SimTxSigner } from "../../../packages/journal/test/sim-chain.js";
import { rpcFor } from "../../../packages/journal/test/world.js";
import { SimFungibleToken } from "../../../packages/near/test/sim/sim-token.js";
import { OneClickSimulator } from "../../../packages/payout/test/fixtures/one-click-simulator.js";
import { NEAR, SUPPLIER_ACCT } from "../../../packages/release/test/chain.js";
import type { CashOutModule } from "../src/app.js";
import { type ApiWorld, apiWorld, type Res } from "./m07-world.js";

const TOKEN = "sim-usd.testnet";
const ORIGIN_ASSET = `nep141:${TOKEN}`;
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const input = {
  originAsset: ORIGIN_ASSET,
  destinationAsset: ARB_USDC,
  amount: "2000000",
  recipient: RECIPIENT,
  slippageBps: 100,
};

describe("M52 supplier cash-out routes", () => {
  let a: ApiWorld;
  let sim: OneClickSimulator;
  let simUrl = "";
  let token: SimFungibleToken;
  let tx: NearTxClient;
  /** Switches of the module under test: which network 1Click settles on, and a chain read fault. */
  let providerNetwork: "near-testnet" | "near-mainnet" = "near-testnet";
  let balanceFault = false;
  let txFault = false;

  const supplier = () => a.actors.supplier as Actor;
  const path = (suffix = "") => `/v1/trades/${a.w.c.t}/cash-out${suffix}`;
  const now = () => a.w.c.w.h.clock.now();
  const reason = (r: Res) => r.json?.error?.details?.reason as string | undefined;

  /** The supplier's own client asks 1Click for the real quote (the API never does). */
  async function ownRealQuote(request: unknown): Promise<any> {
    const r = await fetch(`${simUrl}/v0/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(r.status).toBe(201);
    return r.json();
  }

  /** Dry quote through the API, then the real quote by the supplier's own client. */
  async function quoted(over: Partial<typeof input> = {}) {
    const dry = await a.http(supplier(), "POST", path("/dry-quotes"), { ...input, ...over });
    expect(dry.status, dry.text).toBe(201);
    const request = dry.json.realQuote.request;
    const real = await ownRealQuote(request);
    return { dry: dry.json, request, real, depositAddress: real.quote.depositAddress as string };
  }

  const depositBody = (q: { request: any; real: unknown }) => ({
    request: {
      originAsset: q.request.originAsset,
      destinationAsset: q.request.destinationAsset,
      amount: q.request.amount,
      recipient: q.request.recipient,
      slippageBps: q.request.slippageTolerance,
      deadline: q.request.deadline,
    },
    quoteResponse: q.real,
  });

  /** The supplier's own wallet signs and sends a call on the simulated chain. */
  async function walletSend(
    call: FunctionCall,
    from = SUPPLIER_ACCT,
  ): Promise<{ hash: string; out: TxOutcome }> {
    const signer = new SimTxSigner(from);
    const block = await tx.latestBlock();
    const nonce = (await tx.accessKeyNonce(from, signer.publicKey).catch(() => 0n)) + 1n;
    const signed = await signer.sign(call, { nonce, blockHash: block.hash });
    return { hash: signed.txHash, out: await tx.send(signed) };
  }

  const status = async (depositAddress: string, txHash?: string) => {
    const q = new URLSearchParams({ depositAddress });
    if (txHash) q.set("txHash", txHash);
    const r = await a.http(supplier(), "GET", path(`/status?${q.toString()}`));
    expect(r.status, r.text).toBe(200);
    return r.json;
  };

  beforeAll(async () => {
    sim = new OneClickSimulator(undefined, () => now());
    simUrl = await sim.start();
    a = await apiWorld({
      extra: (w) => {
        const rpc = rpcFor(w.url);
        const chainTx = new NearTxClient(rpc);
        const cashOut: CashOutModule = {
          client: new OneClickClient({ baseUrl: simUrl, timeoutMs: 500 }),
          get nearNetwork() {
            return providerNetwork;
          },
          tx: {
            status: (h, s) => (txFault ? Promise.reject(new Error("rpc down")) : chainTx.status(h, s)),
          },
          token: (contract) => ({
            balanceOf: (account) =>
              balanceFault
                ? Promise.reject(new Error("rpc down"))
                : new Nep141Reader(rpc, contract).balanceOf(account),
          }),
        };
        return { cashOut };
      },
    });
    token = new SimFungibleToken(TOKEN);
    token.mint(SUPPLIER_ACCT, 50_000_000n);
    a.w.c.sim.externals.set(TOKEN, token);
    a.w.c.sim.credit("other-wallet.testnet", 10n * NEAR);
    token.mint("other-wallet.testnet", 5_000_000n);
    tx = new NearTxClient(rpcFor(a.w.url));
  });
  afterAll(async () => {
    await a.close();
    await sim.stop();
  });
  beforeEach(() => {
    sim.fault = "none";
    sim.requests.length = 0;
    providerNetwork = "near-testnet";
    balanceFault = false;
    txFault = false;
  });

  it("only the trade's supplier signer reaches any cash-out route", async () => {
    const calls: ["GET" | "POST", string, unknown?][] = [
      ["GET", path()],
      ["POST", path("/dry-quotes"), input],
      ["POST", path("/deposit-calls"), { request: { ...input, deadline: "x" }, quoteResponse: {} }],
      ["GET", path(`/status?depositAddress=${"a".repeat(64)}`)],
    ];
    for (const [method, p, body] of calls) {
      expect((await a.http(null, method, p, body)).status, p).toBe(401);
      for (const who of ["buyer", "inspector", "risk", "supplierAdmin", "supplierClerk"]) {
        const r = await a.http(a.actors[who] as Actor, method, p, body);
        expect([r.status, reason(r)], `${who} ${p}`).toEqual([403, "NOT_SUPPLIER"]);
      }
      const out = await a.http(a.actors.outsiderAdmin as Actor, method, p, body);
      expect(out.status, `outsider ${p}`).toBe(404);
    }
    expect(sim.requests).toEqual([]);
  });

  it("lists what the supplier can choose and says whether a deposit can be offered", async () => {
    const r = await a.http(supplier(), "GET", path());
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({
      status: "READY",
      supplierAccountId: SUPPLIER_ACCT,
      tradeNetwork: "near-testnet",
      providerNetwork: "near-testnet",
      providerUrl: simUrl,
      depositEnabled: true,
      originAssets: [{ assetId: ORIGIN_ASSET, symbol: "SIMUSD", decimals: 6, contract: TOKEN }],
    });
    expect(r.json.destinationAssets.map((x: { blockchain: string }) => x.blockchain)).toEqual([
      "near",
      "arb",
      "base",
      "eth",
    ]);
    providerNetwork = "near-mainnet";
    expect((await a.http(supplier(), "GET", path())).json.depositEnabled).toBe(false);
    sim.fault = "http500";
    const down = await a.http(supplier(), "GET", path());
    expect(down.json).toMatchObject({ status: "PROVIDER_UNAVAILABLE" });
    expect(down.json.originAssets).toBeUndefined();
  });

  it("a dry quote shows amount out, cost and deadline, and the server commits nothing", async () => {
    const r = await a.http(supplier(), "POST", path("/dry-quotes"), input);
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({
      dry: true,
      committed: "NOTHING",
      origin: { assetId: ORIGIN_ASSET, contract: TOKEN, signerId: SUPPLIER_ACCT },
      destination: { blockchain: "arb", symbol: "USDC", recipient: RECIPIENT },
      quote: {
        amountIn: "2000000",
        amountInFormatted: "2",
        amountOut: "1944000",
        amountOutFormatted: "1.944",
        minAmountOut: "1924560",
        minAmountOutFormatted: "1.92456",
        cost: { usd: "0.056", bps: 280 },
        withdrawFee: "50000",
        timeEstimateSeconds: 45,
        deadline: now() + 30 * 60_000,
      },
      depositEnabled: true,
    });
    // The request for the supplier's own client: the same request, dry:false, refund to the supplier.
    expect(r.json.realQuote.request).toEqual({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ORIGIN_ASSET,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ARB_USDC,
      amount: "2000000",
      refundTo: SUPPLIER_ACCT,
      refundType: "ORIGIN_CHAIN",
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(now() + 30 * 60_000).toISOString(),
    });
    expect(r.json.realQuote.url).toBe(`${simUrl}/v0/quote`);
    expect(r.json.realQuote.powershell).toContain(`-Uri '${simUrl}/v0/quote'`);
    expect(r.json.realQuote.powershell).toContain(JSON.stringify(r.json.realQuote.request));
    // What the server sent to 1Click: the token list and one dry quote. No deposit address exists.
    expect(sim.requests.map((q) => [q.method, q.path, q.body?.["dry"]])).toEqual([
      ["GET", "/v0/tokens", undefined],
      ["POST", "/v0/quote", true],
    ]);
    expect(sim.requests[1]?.body).toEqual({ ...r.json.realQuote.request, dry: true });
    expect(sim.swaps.size).toBe(0);
  });

  it("refuses malformed input before asking 1Click, and reports a 1Click refusal as such", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ recipient: "0x11 11" }, "recipient"],
      [{ recipient: "x';rm -rf" }, "recipient"],
      [{ recipient: "$(whoami)" }, "recipient"],
      [{ amount: "0" }, "amount"],
      [{ amount: "1.5" }, "amount"],
      [{ slippageBps: 0 }, "slippageBps"],
      [{ slippageBps: 501 }, "slippageBps"],
      [{ extra: 1 }, "extra"],
    ];
    for (const [over, what] of bad) {
      const r = await a.http(supplier(), "POST", path("/dry-quotes"), { ...input, ...over });
      expect(r.status, what).toBe(400);
    }
    expect(sim.requests).toEqual([]);
    const notNear = await a.http(supplier(), "POST", path("/dry-quotes"), {
      ...input,
      originAsset: ARB_USDC,
    });
    expect([notNear.status, reason(notNear)]).toEqual([400, "ORIGIN_ASSET"]);
    const unknown = await a.http(supplier(), "POST", path("/dry-quotes"), {
      ...input,
      destinationAsset: "nep141:not-listed.near",
    });
    expect([unknown.status, reason(unknown)]).toEqual([400, "DESTINATION_ASSET"]);
    const refused = await a.http(supplier(), "POST", path("/dry-quotes"), {
      ...input,
      recipient: "someone.near",
    });
    expect(refused.status).toBe(400);
    expect(refused.json.error.details).toEqual({
      reason: "ONE_CLICK_REFUSED",
      providerStatus: 400,
      providerMessage: "recipient is not valid for the destination chain",
    });
  });

  it("a silent, failing or garbled 1Click is an upstream error, never a quote", async () => {
    for (const [fault, http, code] of [
      ["hang", 504, "UPSTREAM_TIMEOUT"],
      ["http500", 502, "UPSTREAM_ERROR"],
      ["garbage", 502, "UPSTREAM_INVALID"],
      ["wrong-shape", 502, "UPSTREAM_INVALID"],
    ] as const) {
      sim.fault = fault;
      const r = await a.http(supplier(), "POST", path("/dry-quotes"), input);
      expect([r.status, r.json.error.code], fault).toEqual([http, code]);
      expect(r.json.quote).toBeUndefined();
    }
  });

  it("when 1Click settles on another network the quote is a preview and no deposit is offered", async () => {
    const q = await quoted();
    providerNetwork = "near-mainnet";
    const dry = await a.http(supplier(), "POST", path("/dry-quotes"), input);
    expect(dry.status, dry.text).toBe(201);
    expect(dry.json).toMatchObject({ depositEnabled: false, realQuote: null });
    expect(dry.json.depositDisabledReason).toContain("near-mainnet");
    const r = await a.http(supplier(), "POST", path("/deposit-calls"), depositBody(q));
    expect([r.status, reason(r)]).toEqual([409, "CASH_OUT_WRONG_NETWORK"]);
  });

  it("turns the supplier's own real quote into one ft_transfer for the supplier's wallet", async () => {
    const q = await quoted();
    sim.requests.length = 0;
    const r = await a.http(supplier(), "POST", path("/deposit-calls"), depositBody(q));
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({
      signerId: SUPPLIER_ACCT,
      depositAddress: q.depositAddress,
      amountIn: "2000000",
      minAmountOut: "1924560",
      network: "near-testnet",
      sentByDockside: false,
      call: {
        receiverId: TOKEN,
        methodName: "ft_transfer",
        args: { receiver_id: q.depositAddress, amount: "2000000" },
        depositYocto: "1",
      },
    });
    expect(r.json.nearCli).toContain(`near contract call-function as-transaction ${TOKEN} ft_transfer`);
    expect(r.json.nearCli).toContain(`sign-as ${SUPPLIER_ACCT} network-config testnet`);
    expect(r.json.nearCli).toContain("attached-deposit '1 yoctoNEAR'");
    // The server only read: the token list and the status of the deposit address.
    expect(sim.requests.map((x) => x.method)).toEqual(["GET", "GET"]);
    expect(token.transfers).toEqual([]);
  });

  it("refuses a quote that is not the previewed one, not 1Click's, or no longer waiting", async () => {
    const q = await quoted();
    const body = depositBody(q);
    const post = (b: unknown) => a.http(supplier(), "POST", path("/deposit-calls"), b);
    const fields = (r: Res) => [r.status, reason(r), r.json?.error?.details?.fields];

    // A deposit address 1Click never issued (a tampered or invented answer).
    const forged = { ...q.real, quote: { ...q.real.quote, depositAddress: "f".repeat(64) } };
    const r1 = await post({ ...body, quoteResponse: forged });
    expect([r1.status, reason(r1)]).toEqual([400, "DEPOSIT_ADDRESS_UNKNOWN"]);

    // A real 1Click quote, but for someone else's refund account or another recipient.
    const foreign = await ownRealQuote({ ...q.request, refundTo: "attacker.testnet" });
    expect(fields(await post({ ...body, quoteResponse: foreign }))).toEqual([
      400,
      "QUOTE_MISMATCH",
      "refundTo",
    ]);
    const elsewhere = await ownRealQuote({
      ...q.request,
      recipient: "0x2222222222222222222222222222222222222222",
    });
    expect(fields(await post({ ...body, quoteResponse: elsewhere }))).toEqual([
      400,
      "QUOTE_MISMATCH",
      "recipient",
    ]);

    // The previewed answer with the deposit address of that other real quote swapped in.
    const swapped = { ...q.real, quote: { ...q.real.quote, depositAddress: elsewhere.quote.depositAddress } };
    expect(fields(await post({ ...body, quoteResponse: swapped }))).toEqual([
      400,
      "QUOTE_MISMATCH",
      "recipient",
    ]);

    // The request the supplier says was previewed is rebuilt with the supplier's own account.
    expect(fields(await post({ ...body, request: { ...body.request, amount: "9000000" } }))).toEqual([
      400,
      "QUOTE_MISMATCH",
      "amount,amountIn",
    ]);
    expect((await post({ ...body, quoteResponse: { hello: "world" } })).status).toBe(400);

    // 1Click cannot be asked: no call is handed out on the pasted answer alone.
    sim.fault = "hang";
    const silent = await post(body);
    expect([silent.status, silent.json.error.code]).toEqual([504, "UPSTREAM_TIMEOUT"]);
    expect(silent.json.call).toBeUndefined();
    sim.fault = "none";

    // Already deposited: track it, do not build another deposit.
    sim.observeDeposit(q.depositAddress, "2000000");
    const late = await post(body);
    expect([late.status, reason(late)]).toEqual([409, "CASH_OUT_NOT_PENDING"]);
  });

  it("refuses a real quote whose deposit window has closed", async () => {
    const q = await quoted();
    a.w.c.w.h.clock.advance(29 * 60_000 + 1);
    const r = await a.http(supplier(), "POST", path("/deposit-calls"), depositBody(q));
    expect([r.status, reason(r), r.json.error.details.fields]).toEqual([
      400,
      "QUOTE_MISMATCH",
      "deadline_passed",
    ]);
    const st = await status(q.depositAddress);
    expect(st).toMatchObject({ state: "QUOTE_EXPIRED", maySendDeposit: false, depositCall: null });
  });

  it("reconciles a cash-out from 1Click and the chain, and never answers doubt with a resend", async () => {
    const q = await quoted();
    const made = await a.http(supplier(), "POST", path("/deposit-calls"), depositBody(q));
    expect(made.status, made.text).toBe(201);
    const call = made.json.call as FunctionCall;
    const addr = q.depositAddress;

    // 1. Nothing sent yet: one deposit may be sent, and the call is offered.
    const s1 = await status(addr);
    expect(s1).toMatchObject({
      state: "AWAITING_DEPOSIT",
      maySendDeposit: true,
      terminal: false,
      provider: { read: "STATUS", status: "PENDING_DEPOSIT", recipient: RECIPIENT },
      deposit: { read: "NOT_PROVIDED", balance: "0" },
    });
    expect(s1.depositCall.call).toEqual(call);

    // 2. The supplier's wallet sends it, but the token refuses (receiver not registered): the
    //    chain proves nothing moved, so the same deposit may be sent again.
    const failed = await walletSend(call);
    expect(failed.out.kind).toBe("FINAL_FAILURE");
    expect(token.balanceOf(SUPPLIER_ACCT)).toBe(50_000_000n);
    const s2 = await status(addr, failed.hash);
    expect(s2).toMatchObject({
      state: "DEPOSIT_FAILED_NO_TRANSFER",
      maySendDeposit: true,
      deposit: { read: "FAILED_NO_TRANSFER", balance: "0" },
    });
    expect(s2.depositCall.call).toEqual(call);

    // 3. Hashes that prove nothing: unknown to the node, or a different transfer.
    const s3 = await status(addr, "9".repeat(44));
    expect(s3).toMatchObject({ state: "UNKNOWN", maySendDeposit: false, depositCall: null });
    expect(s3.deposit.read).toBe("NOT_FOUND");
    token.register("somewhere-else.testnet");
    const other = await walletSend({
      ...call,
      args: { receiver_id: "somewhere-else.testnet", amount: "2000000" },
    });
    expect(other.out.kind).toBe("FINAL_SUCCESS");
    const s3b = await status(addr, other.hash);
    expect(s3b).toMatchObject({ state: "UNKNOWN", maySendDeposit: false, depositCall: null });
    expect(s3b.deposit.read).toBe("DIFFERENT_TRANSACTION");

    // 4. Unreadable chain: no deposit is allowed on a failed read.
    balanceFault = true;
    expect(await status(addr)).toMatchObject({ state: "UNKNOWN", maySendDeposit: false, depositCall: null });
    expect(await status(addr, failed.hash)).toMatchObject({ state: "UNKNOWN", maySendDeposit: false });
    balanceFault = false;
    txFault = true;
    expect(await status(addr, failed.hash)).toMatchObject({
      state: "UNKNOWN",
      maySendDeposit: false,
      deposit: { read: "UNREADABLE" },
    });
    txFault = false;

    // 5. The deposit succeeds on chain; 1Click has not noticed yet. With the hash, with the old
    //    failed hash and with no hash at all the answer is the same: do not send again.
    token.register(addr);
    const sent = await walletSend(call);
    expect(sent.out.kind).toBe("FINAL_SUCCESS");
    expect(token.balanceOf(addr)).toBe(2_000_000n);
    for (const hash of [sent.hash, failed.hash, undefined]) {
      const s = await status(addr, hash);
      expect(s, String(hash)).toMatchObject({
        state: "DEPOSIT_SENT_WAITING_FOR_PROVIDER",
        maySendDeposit: false,
        depositCall: null,
        deposit: { balance: "2000000" },
      });
      expect(s.reason).toContain("Do not send the deposit again");
    }

    // 6. 1Click stops answering in the middle: UNKNOWN, no call, nothing resubmitted.
    for (const fault of ["hang", "http500", "garbage"] as const) {
      sim.fault = fault;
      const s = await status(addr, sent.hash);
      expect(s, fault).toMatchObject({
        state: "UNKNOWN",
        maySendDeposit: false,
        terminal: false,
        depositCall: null,
        provider: { read: "UNREADABLE", status: null },
      });
    }
    sim.fault = "none";

    // 7. 1Click sees the deposit, executes and delivers.
    sim.observeDeposit(addr, "2000000", sent.hash);
    expect(await status(addr, sent.hash)).toMatchObject({
      state: "IN_PROGRESS",
      maySendDeposit: false,
      depositCall: null,
      provider: { status: "PROCESSING", depositedAmount: "2000000", originChainTxHashes: [sent.hash] },
      deposit: { read: "NOT_READ" },
    });
    sim.settle(addr, "0xdestinationtx");
    expect(await status(addr)).toMatchObject({
      state: "DELIVERED",
      terminal: true,
      maySendDeposit: false,
      depositCall: null,
      provider: { status: "SUCCESS", amountOut: "1944000", destinationChainTxHashes: ["0xdestinationtx"] },
    });
    // Exactly one deposit left the supplier's account for this cash-out.
    expect(token.transfers.filter((t) => t.to === addr)).toEqual([
      { from: SUPPLIER_ACCT, to: addr, amount: 2_000_000n, memo: null },
    ]);
  });

  it("reports an incomplete deposit and a refund without offering another deposit", async () => {
    const q = await quoted({ amount: "3000000" });
    sim.observeDeposit(q.depositAddress, "1000000");
    expect(await status(q.depositAddress)).toMatchObject({
      state: "INCOMPLETE_DEPOSIT",
      maySendDeposit: false,
      depositCall: null,
      provider: { depositedAmount: "1000000", amountIn: "3000000" },
    });
    sim.refund(q.depositAddress, "INCOMPLETE_DEPOSIT_AFTER_DEADLINE");
    expect(await status(q.depositAddress)).toMatchObject({
      state: "REFUNDED",
      terminal: true,
      maySendDeposit: false,
      provider: { refundedAmount: "1000000", refundReason: "INCOMPLETE_DEPOSIT_AFTER_DEADLINE" },
    });
  });

  it("tracks only this supplier's own cash-outs and validates what it is asked to read", async () => {
    const foreign = await ownRealQuote({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ORIGIN_ASSET,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ARB_USDC,
      amount: "1000000",
      refundTo: "other-wallet.testnet",
      refundType: "ORIGIN_CHAIN",
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(now() + 600_000).toISOString(),
    });
    const r = await a.http(supplier(), "GET", path(`/status?depositAddress=${foreign.quote.depositAddress}`));
    expect(r.status).toBe(404);
    expect(await status("e".repeat(64))).toMatchObject({
      state: "UNKNOWN",
      maySendDeposit: false,
      provider: { read: "UNKNOWN_ADDRESS" },
    });
    for (const bad of ["", "UPPER.near", "a b", "x".repeat(65)]) {
      const q = new URLSearchParams({ depositAddress: bad });
      expect((await a.http(supplier(), "GET", path(`/status?${q.toString()}`))).status, bad).toBe(400);
    }
    const badHash = await a.http(
      supplier(),
      "GET",
      path(`/status?depositAddress=${"e".repeat(64)}&txHash=not-a-hash`),
    );
    expect(badHash.status).toBe(400);
  });
});

describe("M52 cash-out without a configured 1Click endpoint", () => {
  let a: ApiWorld;
  beforeAll(async () => {
    a = await apiWorld();
  });
  afterAll(() => a.close());

  it("says NOT_CONFIGURED and refuses every other cash-out route", async () => {
    const supplier = a.actors.supplier as Actor;
    const base = `/v1/trades/${a.w.c.t}/cash-out`;
    const r = await a.http(supplier, "GET", base);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ status: "NOT_CONFIGURED", supplierAccountId: SUPPLIER_ACCT });
    const dry = await a.http(supplier, "POST", `${base}/dry-quotes`, input);
    expect([dry.status, dry.json.error.details.reason]).toEqual([409, "CASH_OUT_NOT_CONFIGURED"]);
    const st = await a.http(supplier, "GET", `${base}/status?depositAddress=${"a".repeat(64)}`);
    expect([st.status, st.json.error.details.reason]).toEqual([409, "CASH_OUT_NOT_CONFIGURED"]);
  });
});
