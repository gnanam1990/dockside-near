/**
 * SIMULATED NEP-141 TOKEN — test infrastructure only. A minimal fungible-token contract that the
 * simulated NEAR host (near-sim.ts) dispatches calls to, so the escrow's unexpected-asset path can
 * be driven end to end: `ft_transfer_call` delivers `ft_on_transfer` to the real compiled escrow
 * wasm (predecessor = this token), and the escrow's recovery adapter calls `ft_transfer` here.
 *
 * Modelled: balances, storage registration, the exactly-one-yoctoNEAR rule of `ft_transfer`, the
 * unused-amount refund of `ft_transfer_call`, and atomic failure (a refused call changes nothing,
 * as a panicking receipt reverts on NEAR). Not modelled: gas, storage staking amounts, events.
 */
import type { NearSim } from "./near-sim.js";

export interface ExternalCall {
  readonly predecessor: string;
  readonly depositYocto: bigint;
  readonly sim: NearSim;
}

/** A nested call this contract made while executing (reported as an extra receipt). */
export interface NestedReceipt {
  readonly predecessor: string;
  readonly receiver: string;
  readonly method: string;
  readonly args: string;
  readonly ok: boolean;
  readonly raw: string | null;
  readonly error: string | null;
}

export interface ExternalResult {
  readonly ok: boolean;
  readonly raw: string | null;
  readonly error: string | null;
  readonly nested: NestedReceipt[];
}

export interface SimExternalContract {
  readonly accountId: string;
  call(method: string, args: Record<string, unknown>, c: ExternalCall): ExternalResult;
  view(method: string, args: Record<string, unknown>): unknown;
}

const STORAGE = "1250000000000000000000";

function amountOf(v: unknown): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(v))
    throw new Error("amount must be a u128 string");
  return BigInt(v);
}

export class SimFungibleToken implements SimExternalContract {
  readonly balances = new Map<string, bigint>();
  readonly registered = new Set<string>();
  /** Fault switch: the next N `ft_transfer` calls panic (a token that refuses the transfer). */
  failTransfers = 0;
  readonly transfers: { from: string; to: string; amount: bigint; memo: string | null }[] = [];

  constructor(
    readonly accountId: string,
    readonly symbol = "SIMUSD",
    readonly decimals = 6,
  ) {}

  register(account: string): void {
    this.registered.add(account);
    if (!this.balances.has(account)) this.balances.set(account, 0n);
  }

  unregister(account: string): void {
    this.registered.delete(account);
  }

  mint(account: string, amount: bigint): void {
    this.register(account);
    this.balances.set(account, this.balanceOf(account) + amount);
  }

  balanceOf(account: string): bigint {
    return this.balances.get(account) ?? 0n;
  }

  private move(from: string, to: string, amount: bigint): void {
    if (!this.registered.has(from)) throw new Error(`The account ${from} is not registered`);
    if (!this.registered.has(to)) throw new Error(`The account ${to} is not registered`);
    if (amount <= 0n) throw new Error("The amount should be a positive number");
    if (from === to) throw new Error("Sender and receiver should be different");
    if (this.balanceOf(from) < amount) throw new Error("The account doesn't have enough balance");
    this.balances.set(from, this.balanceOf(from) - amount);
    this.balances.set(to, this.balanceOf(to) + amount);
  }

  call(method: string, args: Record<string, unknown>, c: ExternalCall): ExternalResult {
    const done = (raw: unknown, nested: NestedReceipt[] = []): ExternalResult => ({
      ok: true,
      raw: raw === undefined ? "" : JSON.stringify(raw),
      error: null,
      nested,
    });
    try {
      switch (method) {
        case "storage_deposit": {
          const who = typeof args["account_id"] === "string" ? args["account_id"] : c.predecessor;
          this.register(who);
          return done({ total: STORAGE, available: "0" });
        }
        case "ft_transfer": {
          if (c.depositYocto !== 1n) throw new Error("Requires attached deposit of exactly 1 yoctoNEAR");
          if (this.failTransfers > 0) {
            this.failTransfers--;
            throw new Error("Smart contract panicked: transfer refused by the token");
          }
          const to = String(args["receiver_id"]);
          const amount = amountOf(args["amount"]);
          this.move(c.predecessor, to, amount);
          const memo = typeof args["memo"] === "string" ? args["memo"] : null;
          this.transfers.push({ from: c.predecessor, to, amount, memo });
          return done(undefined);
        }
        case "ft_transfer_call": {
          if (c.depositYocto !== 1n) throw new Error("Requires attached deposit of exactly 1 yoctoNEAR");
          const to = String(args["receiver_id"]);
          const amount = amountOf(args["amount"]);
          const msg = typeof args["msg"] === "string" ? args["msg"] : "";
          this.move(c.predecessor, to, amount);
          this.transfers.push({ from: c.predecessor, to, amount, memo: null });
          // The receiver's ft_on_transfer runs with this token as predecessor; unused value returns.
          const cbArgs = { sender_id: c.predecessor, amount: amount.toString(10), msg };
          let unused = amount;
          let nested: NestedReceipt;
          if (to === c.sim.contractId) {
            const r = c.sim.call("ft_on_transfer", cbArgs, { predecessor: this.accountId });
            if (r.ok && typeof r.value === "string") unused = amountOf(r.value);
            nested = {
              predecessor: this.accountId,
              receiver: to,
              method: "ft_on_transfer",
              args: JSON.stringify(cbArgs),
              ok: r.ok,
              raw: r.raw,
              error: r.error,
            };
          } else {
            nested = {
              predecessor: this.accountId,
              receiver: to,
              method: "ft_on_transfer",
              args: JSON.stringify(cbArgs),
              ok: false,
              raw: null,
              error: "receiver has no ft_on_transfer",
            };
          }
          if (unused > amount) unused = amount;
          if (unused > 0n) this.move(to, c.predecessor, unused);
          return done((amount - unused).toString(10), [nested]);
        }
        default:
          throw new Error(`MethodNotFound: ${method}`);
      }
    } catch (e) {
      return { ok: false, raw: null, error: (e as Error).message, nested: [] };
    }
  }

  view(method: string, args: Record<string, unknown>): unknown {
    switch (method) {
      case "ft_balance_of":
        return this.balanceOf(String(args["account_id"])).toString(10);
      case "storage_balance_of":
        return this.registered.has(String(args["account_id"])) ? { total: STORAGE, available: "0" } : null;
      case "ft_metadata":
        return {
          spec: "ft-1.0.0",
          name: `${this.symbol} (simulated)`,
          symbol: this.symbol,
          decimals: this.decimals,
        };
      default:
        throw new Error(`MethodNotFound: ${method}`);
    }
  }
}
