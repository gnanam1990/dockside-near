import { readFileSync } from "node:fs";
import { base58Decode, fail, type JsonValue } from "@dockside/core";
import type { JsonRpcNearClient } from "./rpc.js";

/**
 * Chain preflight for a runtime that talks to a real NEAR node (M43). Before the API or the worker
 * serves anything against an escrow, it proves that:
 *
 * 1. the node is not mainnet (`status.chain_id`), and is the chain the operator named
 *    (`testnet` for NEAR testnet; a local near-sandbox node reports its own id and is allowed only
 *    on a loopback RPC address);
 * 2. the escrow account's on-chain code hash equals the build manifest's `nearCodeHash` (the
 *    reproducible container build, ADR-0015) — a different contract, an empty account or an
 *    upgraded one is refused;
 * 3. the contract itself says it was initialised for `near-testnet` (`get_config`).
 *
 * Any failure is a CONFIG_INVALID (or WRONG_NETWORK) with a reason code; the process must not start.
 */

export interface PreflightOptions {
  readonly rpc: Pick<JsonRpcNearClient, "request" | "viewAccount" | "callView">;
  readonly rpcUrl: string;
  readonly escrowId: string;
  /** Path of build-manifest.json (`contract.nearCodeHash`) or an artifact record (`nearCodeHash`). */
  readonly manifestPath: string;
  /** The `status.chain_id` the operator expects: `testnet`, or a local sandbox's id on loopback. */
  readonly expectedChainId: string;
}

export interface PreflightResult {
  readonly chainId: string;
  readonly escrowId: string;
  readonly codeHash: string;
  readonly contractNetwork: string;
  readonly blockHeight: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isObj(v: unknown): v is Record<string, JsonValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The expected NEAR code hash from a build manifest or an artifact record. */
export function manifestCodeHash(path: string, escrowId: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("CONFIG_INVALID", "escrow manifest is missing or not JSON", { reason: "MANIFEST_UNREADABLE" });
  }
  if (!isObj(doc))
    fail("CONFIG_INVALID", "escrow manifest is not an object", { reason: "MANIFEST_MALFORMED" });
  const contract = isObj(doc["contract"]) ? doc["contract"] : doc;
  const hash = contract["nearCodeHash"];
  let ok = false;
  if (typeof hash === "string") {
    try {
      ok = base58Decode(hash).length === 32;
    } catch {
      ok = false;
    }
  }
  if (!ok || typeof hash !== "string")
    fail("CONFIG_INVALID", "escrow manifest has no NEAR code hash", { reason: "MANIFEST_MALFORMED" });
  const dep = doc["deployment"];
  if (isObj(dep) && typeof dep["accountId"] === "string" && dep["accountId"] !== escrowId)
    fail("CONFIG_INVALID", "escrow manifest records another deployment account", {
      reason: "MANIFEST_OTHER_ACCOUNT",
    });
  return hash;
}

export async function preflightEscrow(o: PreflightOptions): Promise<PreflightResult> {
  const url = new URL(o.rpcUrl);
  if (/mainnet/i.test(url.hostname) || o.expectedChainId === "mainnet")
    fail("WRONG_NETWORK", "mainnet is refused: only NEAR testnet (or a local sandbox) is supported", {
      reason: "MAINNET_REFUSED",
    });
  if (!o.escrowId.endsWith(".testnet"))
    fail("WRONG_NETWORK", "the escrow must be a .testnet account", { reason: "NOT_TESTNET_ACCOUNT" });
  if (o.expectedChainId !== "testnet" && !LOOPBACK.has(url.hostname))
    fail("CONFIG_INVALID", "a chain other than testnet is accepted only on a loopback RPC (local sandbox)", {
      reason: "CHAIN_ID_NOT_LOCAL",
    });
  const expectedHash = manifestCodeHash(o.manifestPath, o.escrowId);

  const status = await o.rpc.request("status", []);
  const chainId = isObj(status) && typeof status["chain_id"] === "string" ? status["chain_id"] : null;
  if (chainId === null) fail("UPSTREAM_INVALID", "node status has no chain_id");
  if (chainId === "mainnet")
    fail("WRONG_NETWORK", "the RPC endpoint serves NEAR mainnet; refused", { reason: "MAINNET_REFUSED" });
  if (chainId !== o.expectedChainId)
    fail("WRONG_NETWORK", "the RPC endpoint serves another chain than configured", {
      reason: "CHAIN_ID_MISMATCH",
      chainId,
    });

  const account = await o.rpc.viewAccount(o.escrowId);
  if (account.codeHash !== expectedHash)
    fail("CONFIG_INVALID", "the escrow's on-chain code hash differs from the manifest", {
      reason: "CODE_HASH_MISMATCH",
      onChain: account.codeHash,
      manifest: expectedHash,
    });

  const cfg = await o.rpc.callView(o.escrowId, "get_config", {});
  const network = isObj(cfg.value) && typeof cfg.value["network"] === "string" ? cfg.value["network"] : null;
  if (network !== "near-testnet")
    fail("WRONG_NETWORK", "the escrow was not initialised for near-testnet", {
      reason: "CONTRACT_NETWORK_MISMATCH",
    });
  return {
    chainId,
    escrowId: o.escrowId,
    codeHash: account.codeHash,
    contractNetwork: network,
    blockHeight: account.blockHeight,
  };
}
