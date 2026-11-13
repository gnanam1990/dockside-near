/**
 * LOCAL 1CLICK SIMULATOR — test infrastructure only. It is not 1Click and proves nothing about
 * 1Click's behaviour; it lets Dockside's cash-out code run against the published wire shape
 * (`GET /v0/tokens`, `POST /v0/quote`, `GET /v0/status`) on a loopback port, with switches for the
 * failures a client must survive: no answer, an error answer, an answer that is not the documented
 * shape, and a status that has not caught up with the chain.
 *
 * Modelled: request validation with `400 {message}`, dry quotes without a deposit address, real
 * quotes with a fresh 64-hex NEAR deposit address, the seven documented statuses, and a request log
 * so a test can prove which requests a component sent. Prices are fixed inputs, not market data.
 * Not modelled: authentication, solver competition, the settlement itself.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface SimToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  /** USD per whole token, a fixed test input. */
  readonly price: number;
  readonly contractAddress?: string;
}

export type SimStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export type SimFault = "none" | "hang" | "http500" | "garbage" | "wrong-shape";

export interface SimRequest {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
  readonly authorization: string | null;
}

interface Swap {
  readonly quoteResponse: Record<string, unknown>;
  status: SimStatus;
  updatedAt: string;
  details: Record<string, unknown>;
}

/** The simulator's fee: 30 basis points of the value, plus a flat destination withdrawal fee. */
const FEE_BPS = 30n;

export const DEFAULT_SIM_TOKENS: readonly SimToken[] = [
  {
    assetId: "nep141:sim-usd.testnet",
    decimals: 6,
    blockchain: "near",
    symbol: "SIMUSD",
    price: 1,
    contractAddress: "sim-usd.testnet",
  },
  {
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    decimals: 6,
    blockchain: "arb",
    symbol: "USDC",
    price: 1,
    contractAddress: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
  {
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    decimals: 6,
    blockchain: "base",
    symbol: "USDC",
    price: 1,
    contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  { assetId: "nep141:eth.omft.near", decimals: 18, blockchain: "eth", symbol: "ETH", price: 2500 },
];

const REQUIRED = [
  "dry",
  "swapType",
  "slippageTolerance",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
  "deadline",
] as const;

export class OneClickSimulator {
  readonly requests: SimRequest[] = [];
  readonly swaps = new Map<string, Swap>();
  /** Applies to every `/v0/*` request until changed. */
  fault: SimFault = "none";
  private server: Server | null = null;
  private seq = 0;
  private readonly hanging = new Set<ServerResponse>();

  constructor(
    readonly tokens: readonly SimToken[] = DEFAULT_SIM_TOKENS,
    private readonly now: () => number = Date.now,
  ) {}

  async start(port = 0): Promise<string> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const r of this.hanging) r.destroy();
    const s = this.server;
    this.server = null;
    if (s) {
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  }

  /** What 1Click does when it sees a deposit: full amount -> PROCESSING, less -> INCOMPLETE_DEPOSIT. */
  observeDeposit(depositAddress: string, amount: string, txHash = ""): void {
    const s = this.swap(depositAddress);
    const need = BigInt(String((s.quoteResponse["quote"] as Record<string, unknown>)["amountIn"]));
    s.status = BigInt(amount) >= need ? "PROCESSING" : "INCOMPLETE_DEPOSIT";
    s.details = {
      ...s.details,
      depositedAmount: amount,
      amountIn: amount,
      originChainTxHashes: txHash ? [{ hash: txHash, explorerUrl: "" }] : [],
    };
    this.touch(s);
  }

  settle(depositAddress: string, destinationTxHash: string): void {
    const s = this.swap(depositAddress);
    const q = s.quoteResponse["quote"] as Record<string, unknown>;
    s.status = "SUCCESS";
    s.details = {
      ...s.details,
      amountOut: q["amountOut"],
      amountOutFormatted: q["amountOutFormatted"],
      destinationChainTxHashes: [{ hash: destinationTxHash, explorerUrl: "" }],
    };
    this.touch(s);
  }

  refund(depositAddress: string, reason: string): void {
    const s = this.swap(depositAddress);
    s.status = "REFUNDED";
    s.details = { ...s.details, refundedAmount: s.details["depositedAmount"] ?? "0", refundReason: reason };
    this.touch(s);
  }

  setStatus(depositAddress: string, status: SimStatus): void {
    const s = this.swap(depositAddress);
    s.status = status;
    this.touch(s);
  }

  private swap(depositAddress: string): Swap {
    const s = this.swaps.get(depositAddress);
    if (!s) throw new Error(`simulator: unknown deposit address ${depositAddress}`);
    return s;
  }

  private touch(s: Swap): void {
    s.updatedAt = new Date(this.now()).toISOString();
  }

  private token(assetId: unknown): SimToken | undefined {
    return this.tokens.find((t) => t.assetId === assetId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://sim");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const send = (status: number, value: unknown) => {
      res
        .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(value));
    };

    // Test control surface for a simulator running in another process (browser tests).
    if (url.pathname.startsWith("/__sim/")) {
      if (req.method === "GET" && url.pathname === "/__sim/requests") return send(200, this.requests);
      if (req.method === "POST" && body) {
        const addr = String(body["depositAddress"] ?? "");
        try {
          if (url.pathname === "/__sim/fault") this.fault = String(body["fault"]) as SimFault;
          else if (url.pathname === "/__sim/observe-deposit")
            this.observeDeposit(addr, String(body["amount"]), String(body["txHash"] ?? ""));
          else if (url.pathname === "/__sim/settle") this.settle(addr, String(body["destinationTxHash"]));
          else if (url.pathname === "/__sim/refund") this.refund(addr, String(body["reason"]));
          else return send(404, { message: "no such control" });
        } catch (e) {
          return send(400, { message: (e as Error).message });
        }
        return send(200, { ok: true });
      }
      return send(404, { message: "no such control" });
    }

    this.requests.push({
      method: req.method ?? "",
      path: url.pathname + url.search,
      body,
      authorization: req.headers.authorization ?? null,
    });
    switch (this.fault) {
      case "hang":
        this.hanging.add(res);
        res.on("close", () => this.hanging.delete(res));
        return;
      case "http500":
        return send(500, { message: "Internal server error" });
      case "garbage":
        res.writeHead(200, { "content-type": "application/json" }).end("<html>upstream proxy error</html>");
        return;
      case "wrong-shape":
        return send(200, { status: "DONE", quote: { amountOut: 12 }, correlationId: 7 });
      case "none":
        break;
    }

    if (req.method === "GET" && url.pathname === "/v0/tokens")
      return send(
        200,
        this.tokens.map((t) => ({ ...t, priceUpdatedAt: new Date(this.now()).toISOString() })),
      );
    if (req.method === "POST" && url.pathname === "/v0/quote") {
      this.quote(body, send);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v0/status") {
      const addr = url.searchParams.get("depositAddress");
      if (!addr) return send(400, { message: "depositAddress is required" });
      const s = this.swaps.get(addr);
      if (!s) return send(404, { message: `Deposit address ${addr} not found` });
      return send(200, {
        correlationId: `sim-status-${++this.seq}`,
        quoteResponse: s.quoteResponse,
        status: s.status,
        updatedAt: s.updatedAt,
        swapDetails: {
          intentHashes: [],
          nearTxHashes: [],
          originChainTxHashes: [],
          destinationChainTxHashes: [],
          ...s.details,
        },
      });
    }
    send(404, { message: "Not found" });
  }

  private quote(b: Record<string, unknown> | null, send: (status: number, value: unknown) => void): unknown {
    if (!b) return send(400, { message: "request body must be JSON" });
    for (const k of REQUIRED) if (b[k] === undefined) return send(400, { message: `${k} is required` });
    if (typeof b["dry"] !== "boolean") return send(400, { message: "dry must be a boolean" });
    if (b["swapType"] !== "EXACT_INPUT") return send(400, { message: "swapType is not supported" });
    if (b["depositType"] !== "ORIGIN_CHAIN" || b["refundType"] !== "ORIGIN_CHAIN")
      return send(400, { message: "depositType/refundType is not supported" });
    if (b["recipientType"] !== "DESTINATION_CHAIN")
      return send(400, { message: "recipientType is not supported" });
    const origin = this.token(b["originAsset"]);
    const dest = this.token(b["destinationAsset"]);
    if (!origin) return send(400, { message: "tokenIn is not valid" });
    if (!dest) return send(400, { message: "tokenOut is not valid" });
    if (typeof b["amount"] !== "string" || !/^[1-9][0-9]{0,40}$/.test(b["amount"]))
      return send(400, { message: "amount must be a positive integer string" });
    const slip = b["slippageTolerance"];
    if (typeof slip !== "number" || !Number.isInteger(slip) || slip < 0 || slip > 10_000)
      return send(400, { message: "slippageTolerance must be basis points" });
    const deadline = Date.parse(String(b["deadline"]));
    if (!Number.isFinite(deadline) || deadline <= this.now())
      return send(400, { message: "deadline must be in the future" });
    if (typeof b["recipient"] !== "string" || b["recipient"].length < 2)
      return send(400, { message: "recipient is not valid" });
    if (dest.blockchain !== "near" && /\.(near|testnet)$/.test(b["recipient"]))
      return send(400, { message: "recipient is not valid for the destination chain" });

    // Value in micro-USD, then into destination base units, minus the fee and the withdrawal fee.
    const amountIn = BigInt(b["amount"]);
    const micro = (p: number) => BigInt(Math.round(p * 1_000_000));
    const usdMicro = (amountIn * micro(origin.price)) / 10n ** BigInt(origin.decimals);
    const gross = (usdMicro * 10n ** BigInt(dest.decimals)) / micro(dest.price);
    const withdrawFee = (50_000n * 10n ** BigInt(dest.decimals)) / micro(dest.price);
    const amountOut = gross - (gross * FEE_BPS) / 10_000n - withdrawFee;
    if (amountOut <= 0n) return send(400, { message: "Amount is too low for bridge, try at least 1" });
    const minAmountOut = amountOut - (amountOut * BigInt(slip)) / 10_000n;
    const fmt = (v: bigint, decimals: number) => {
      const s = v.toString().padStart(decimals + 1, "0");
      const frac = s.slice(s.length - decimals).replace(/0+$/, "");
      return `${s.slice(0, s.length - decimals)}${frac ? `.${frac}` : ""}`;
    };
    const usdOf = (v: bigint, t: SimToken) => fmt((v * micro(t.price)) / 10n ** BigInt(t.decimals), 6);
    const n = ++this.seq;
    const quote: Record<string, unknown> = {
      amountIn: amountIn.toString(),
      amountInFormatted: fmt(amountIn, origin.decimals),
      amountInUsd: usdOf(amountIn, origin),
      minAmountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      amountOutFormatted: fmt(amountOut, dest.decimals),
      amountOutUsd: usdOf(amountOut, dest),
      minAmountOut: minAmountOut.toString(),
      timeEstimate: 45,
      withdrawFee: withdrawFee.toString(),
    };
    if (b["dry"] === false) {
      quote["depositAddress"] = createHash("sha256")
        .update(`sim-deposit-${n}-${JSON.stringify(b)}`)
        .digest("hex");
      quote["deadline"] = new Date(deadline).toISOString();
      quote["timeWhenInactive"] = new Date(deadline).toISOString();
    }
    const response = {
      correlationId: `sim-quote-${n}`,
      timestamp: new Date(this.now()).toISOString(),
      signature: `ed25519:sim-${createHash("sha256").update(JSON.stringify(quote)).digest("hex")}`,
      quoteRequest: b,
      quote,
    };
    if (b["dry"] === false)
      this.swaps.set(String(quote["depositAddress"]), {
        quoteResponse: response,
        status: "PENDING_DEPOSIT",
        updatedAt: new Date(this.now()).toISOString(),
        details: {},
      });
    return send(201, response);
  }
}
