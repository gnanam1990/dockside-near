import { parseNearAccountId, parseWith } from "@dockside/core";
import { z } from "zod";
import type { NearRpc } from "./rpc.js";

/**
 * Read-only NEP-141 views used to validate an unexpected-asset recovery before the risk/policy
 * principal approves it (REFUND-POLICY `UNEXPECTED_ASSET_RECOVERY`: "transfer capability and
 * simulation/read-only validation"). These are observations of the token contract named by the
 * escrow's own record, never an authority: the escrow contract re-checks the request, and the
 * token contract decides whether `ft_transfer` succeeds.
 */
const u128 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/)
  .transform((s) => BigInt(s));
const storageSchema = z.object({ total: z.string(), available: z.string() }).passthrough().nullable();
const metadataSchema = z
  .object({ spec: z.string(), name: z.string(), symbol: z.string(), decimals: z.number().int() })
  .passthrough();

export class Nep141Reader {
  readonly tokenId: string;

  constructor(
    private readonly rpc: NearRpc,
    tokenId: string,
  ) {
    this.tokenId = parseNearAccountId(tokenId, {});
  }

  async balanceOf(accountId: string): Promise<bigint> {
    const r = await this.rpc.callView(this.tokenId, "ft_balance_of", {
      account_id: parseNearAccountId(accountId, {}),
    });
    return parseWith(u128, r.value);
  }

  /** Whether `accountId` is storage-registered (an unregistered receiver makes ft_transfer fail). */
  async isRegistered(accountId: string): Promise<boolean> {
    const r = await this.rpc.callView(this.tokenId, "storage_balance_of", {
      account_id: parseNearAccountId(accountId, {}),
    });
    return parseWith(storageSchema, r.value) !== null;
  }

  async metadata(): Promise<z.output<typeof metadataSchema>> {
    const r = await this.rpc.callView(this.tokenId, "ft_metadata", {});
    return parseWith(metadataSchema, r.value);
  }
}
