import type { TypedJson } from "@dockside/core";
import { type DemoConfig, parseDemoConfig } from "./attacks.js";

/**
 * Builds the attack console's demo configuration from the run directory of
 * `run-all --journey attack-demo` (journey.json). Everything taken is a public fact of the demo
 * trade (the arguments of its transactions, its ids and accounts); the run's key seed file is
 * never read.
 */

export const TESTNET_RPC = [
  "https://test.rpc.fastnear.com",
  "https://archival-rpc.testnet.fastnear.com",
] as const;
export const TESTNET_EXPLORER = "https://testnet.nearblocks.io/txns/";

interface JourneyStep {
  readonly step: string;
  readonly method?: string;
  readonly signer?: string;
  readonly txHash?: string;
  readonly mirror?: readonly { readonly method: string; readonly args: Record<string, unknown> }[];
}

interface JourneyRecord {
  readonly network: string;
  readonly contractId: string;
  readonly journey: string;
  readonly ok: boolean;
  readonly tradeId: string;
  readonly releaseIntentId: string | null;
  readonly steps: readonly JourneyStep[];
  readonly ledger: { readonly totals: Record<string, string>; readonly funders: Record<string, unknown> };
  readonly release: { readonly payoutDestination: string };
  readonly holds: readonly { readonly holdId: string }[];
}

export function notSetUpConfig(): DemoConfig {
  return {
    schema: "dockside/attack-demo@1",
    network: "testnet",
    status: "NOT_SET_UP",
    rpc: [...TESTNET_RPC],
    explorer: TESTNET_EXPLORER,
    relay: null,
    escrow: null,
    tradeId: null,
    releaseIntentId: null,
    holdId: null,
    amountYocto: null,
    parties: null,
    attacker: null,
    baselineNonce: null,
    setup: [],
    terms: null,
    approval: null,
    recorded: [],
  };
}

export function demoConfigFromJourney(
  j: JourneyRecord,
  o: {
    readonly attacker: { readonly accountId: string; readonly publicKey: string };
    readonly baselineNonce: bigint;
    readonly rpc?: readonly string[];
    readonly explorer?: string;
    readonly relay?: string | null;
  },
): DemoConfig {
  if (j.journey !== "attack-demo") throw new Error(`journey.json is a ${j.journey} journey, not attack-demo`);
  if (j.ok !== true) throw new Error("the attack-demo journey did not pass its checks");
  const step = (id: string) => {
    const s = j.steps.find((x) => x.step === id && x.txHash);
    const call = s?.mirror?.[0];
    if (!s?.txHash || !call) throw new Error(`journey.json has no completed ${id} step`);
    return { txHash: s.txHash, args: call.args };
  };
  const register = step("register");
  const approval = step("approval");
  const buyers = Object.keys(j.ledger.funders);
  if (buyers.length !== 1) throw new Error("the demo trade must have exactly one funder");
  const config = {
    schema: "dockside/attack-demo@1",
    network: j.network,
    status: "LIVE",
    rpc: [...(o.rpc ?? TESTNET_RPC)],
    explorer: o.explorer ?? TESTNET_EXPLORER,
    relay: o.relay ?? null,
    escrow: j.contractId,
    tradeId: j.tradeId,
    releaseIntentId: j.releaseIntentId,
    holdId: j.holds[0]?.holdId ?? null,
    amountYocto: j.ledger.totals["funded"] ?? null,
    parties: { buyer: buyers[0] as string, supplier: j.release.payoutDestination },
    attacker: { accountId: o.attacker.accountId, publicKey: o.attacker.publicKey },
    baselineNonce: o.baselineNonce.toString(),
    setup: j.steps
      .filter((s) => s.txHash)
      .map((s) => ({
        step: s.step,
        method: s.method ?? "",
        signer: s.signer ?? "",
        txHash: s.txHash as string,
      })),
    terms: register.args["terms"] as TypedJson,
    approval: {
      txHash: approval.txHash,
      // The exact bytes run-all wrote to the args file near-cli-rs sent (JSON.stringify of these args).
      argsBase64: Buffer.from(JSON.stringify(approval.args), "utf8").toString("base64"),
    },
    recorded: [],
  };
  return parseDemoConfig(config);
}
