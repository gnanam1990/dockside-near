/**
 * Test support for M53: a chain whose escrow is the real `dockside-escrow-core` (the
 * `dockside-journey-mirror` process run-all builds). Every call is decided by the contract's own
 * core code; only the transport is a stand-in: near-cli-rs for run-all's journey, and NEAR
 * transaction bytes for the attack relay (decoded here exactly as nearcore reads them).
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { base58Encode } from "@dockside/core";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INTEGRATION = join(ROOT, "contract/integration");
export const MIRROR = join(
  INTEGRATION,
  "target/release",
  `dockside-journey-mirror${process.platform === "win32" ? ".exe" : ""}`,
);

type Json = Record<string, unknown>;

export function buildMirror(): void {
  const r = spawnSync(
    process.env["CARGO"] ?? "cargo",
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
  if (r.status !== 0 || !existsSync(MIRROR)) throw new Error(`mirror build failed: ${r.stderr}`);
}

export class Core {
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
  close(): void {
    this.child.stdin.end();
  }
}

/** Decode a borsh SignedTransaction with one FunctionCall action (what the relay signs). */
export function decodeSignedCall(encoded: string): {
  signerId: string;
  publicKey: string;
  nonce: bigint;
  receiverId: string;
  method: string;
  argsBytes: Buffer;
  gas: bigint;
  deposit: bigint;
  txHash: string;
} {
  const b = Buffer.from(encoded, "base64");
  let o = 0;
  const u32 = () => {
    const v = b.readUInt32LE(o);
    o += 4;
    return v;
  };
  const str = () => {
    const n = u32();
    const s = b.subarray(o, o + n).toString("utf8");
    o += n;
    return s;
  };
  const signerId = str();
  if (b[o] !== 0) throw new Error("not an ed25519 key");
  const publicKey = `ed25519:${base58Encode(b.subarray(o + 1, o + 33))}`;
  o += 33;
  const nonce = b.readBigUInt64LE(o);
  o += 8;
  const receiverId = str();
  o += 32; // block hash
  if (u32() !== 1) throw new Error("expected exactly one action");
  if (b[o] !== 2) throw new Error("expected a FunctionCall action");
  o += 1;
  const method = str();
  const n = u32();
  const argsBytes = Buffer.from(b.subarray(o, o + n));
  o += n;
  const gas = b.readBigUInt64LE(o);
  o += 8;
  const deposit = b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
  o += 16;
  const txHash = base58Encode(createHash("sha256").update(b.subarray(0, o)).digest());
  return { signerId, publicKey, nonce, receiverId, method, argsBytes, gas, deposit, txHash };
}

/**
 * A chain with one escrow account running the core. `near` stands in for near-cli-rs (run-all),
 * `rpc` for run-all's RPC reader, `relayChain()` for the attack relay's RPC.
 */
export class CoreChain {
  core = new Core();
  time = 1_800_000_000_000;
  blocks = new Map<string, number>();
  txs = new Map<string, Json>();
  nonces = new Map<string, bigint>();
  sent: { hash: string; method: string; signer: string; ok: boolean; code: string | null }[] = [];

  constructor(readonly accounts: { escrow: string; buyer: string; supplier: string; relayer: string }) {}

  async start(): Promise<this> {
    const r = await this.core.send({
      op: "init",
      accounts: {
        contract: this.accounts.escrow,
        buyer: this.accounts.buyer,
        supplier: this.accounts.supplier,
      },
      seed: "d5".repeat(32),
      trade: "attack",
      amountYocto: "1",
      delayMs: 3_600_000,
      t0: this.time,
    });
    if (r["ok"] !== true) throw new Error("mirror init failed");
    return this;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  private block(): string {
    this.time += 1_100;
    const hash = base58Encode(
      createHash("sha256")
        .update(`block-${this.blocks.size + 1}`)
        .digest(),
    );
    this.blocks.set(hash, this.time);
    return hash;
  }

  /** Execute one call on the core as the escrow would; a refusal becomes a failed receipt. */
  async execute(
    method: string,
    args: unknown,
    signer: string,
    deposit: bigint,
    hash: string,
    argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64"),
  ): Promise<Json> {
    const block = this.block();
    const call = { method, args, now: this.time, predecessor: signer, deposit: deposit.toString() };
    const probe = await this.core.send({ op: "probe", ...call });
    let status: Json;
    if (probe["ok"] === true) {
      const applied = await this.core.send({ op: "apply", ...call });
      if (applied["ok"] !== true) throw new Error(`apply ${method} failed after a passing probe`);
      if ((applied["value"] as Json | undefined)?.["transfer"])
        throw new Error("the attack test chain does not model transfers");
      status = { SuccessValue: Buffer.from(JSON.stringify(applied["value"] ?? null)).toString("base64") };
    } else {
      const text = `Smart contract panicked: DOCKSIDE:${String(probe["code"])}: ${String(probe["message"])}`;
      status = {
        Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: text } } } },
      };
    }
    const tx = {
      final_execution_status: "FINAL",
      status,
      transaction: {
        hash,
        signer_id: signer,
        receiver_id: this.accounts.escrow,
        actions: [{ FunctionCall: { method_name: method, args: argsBase64 } }],
      },
      receipts_outcome: [
        { id: `r-${hash}`, block_hash: block, outcome: { executor_id: this.accounts.escrow, status } },
      ],
    };
    this.txs.set(hash, tx);
    this.sent.push({
      hash,
      method,
      signer,
      ok: probe["ok"] === true,
      code: probe["ok"] === true ? null : String(probe["code"]),
    });
    return tx;
  }

  rpc = {
    blockTimeMs: async (hash?: string) => {
      if (hash) return this.blocks.get(hash) as number;
      this.time += 400;
      return this.time;
    },
    view: async (_contract: string, method: string, args: Json) => {
      const r = await this.core.send({ op: "view", method, args, now: this.time });
      if (r["ok"] !== true) throw new Error(`view ${method}: ${String(r["code"])}`);
      return r["value"];
    },
    viewAccount: async (_id: string) => ({ amount: (10n ** 25n).toString() }),
    txStatus: async (hash: string) => {
      const tx = this.txs.get(hash);
      if (!tx) throw new Error(`UNKNOWN_TRANSACTION ${hash}`);
      return tx;
    },
  };

  /** `near contract call-function as-transaction <escrow> <method> file-args <file> ... send`. */
  near = async (argv: string[]) => {
    const [, , , escrow, method, , file, , , , depositText, , signer] = argv as string[];
    if (escrow !== this.accounts.escrow) throw new Error("wrong escrow");
    const args = JSON.parse(readFileSync(file as string, "utf8")) as Json;
    const deposit = BigInt((depositText as string).split(" ")[0] as string);
    const hash = base58Encode(createHash("sha256").update(`cli-${this.sent.length}-${method}`).digest());
    const tx = await this.execute(method as string, args, signer as string, deposit, hash);
    const failed = "Failure" in (tx["status"] as Json);
    const text = `${failed ? "ERROR Transaction failed" : "Transaction Execution Info:"}\n  Transaction ID: ${hash}\n`;
    return { status: failed ? 1 : 0, text, clean: text, txHash: hash };
  };

  /** The attack relay's RPC: views, access key nonces, and `send_tx` of real signed bytes. */
  relayChain(key: { accountId: string; publicKey: string }, startNonce = 100n) {
    this.nonces.set(`${key.accountId}/${key.publicKey}`, startNonce);
    return {
      nowMs: async () => this.time,
      latestBlockHash: async () => this.block(),
      view: (contract: string, method: string, args: Record<string, unknown>) =>
        this.rpc.view(contract, method, args as Json),
      accessKeyNonce: async (accountId: string, publicKey: string) => {
        const n = this.nonces.get(`${accountId}/${publicKey}`);
        if (n === undefined) throw new Error("unknown access key");
        return n;
      },
      txStatus: async (hash: string) => this.rpc.txStatus(hash),
      send: async (encoded: string, txHash: string, signerId: string) => {
        const d = decodeSignedCall(encoded);
        if (d.txHash !== txHash || d.signerId !== signerId)
          throw new Error("signed bytes do not match the hash");
        const id = `${d.signerId}/${d.publicKey}`;
        const n = this.nonces.get(id);
        if (n === undefined || d.nonce !== n + 1n) throw new Error(`InvalidNonce ${d.nonce} after ${n}`);
        if (d.receiverId !== this.accounts.escrow || d.deposit !== 0n)
          throw new Error("a function-call key may only call the escrow without a deposit");
        this.nonces.set(id, d.nonce);
        const text = d.argsBytes.toString("utf8");
        return this.execute(
          d.method,
          JSON.parse(text),
          d.signerId,
          d.deposit,
          d.txHash,
          d.argsBytes.toString("base64"),
        );
      },
    };
  }
}
