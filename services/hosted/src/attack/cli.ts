#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { JsonRpcNearClient, KeyFileTxSigner } from "@dockside/near";
import {
  ATTACK_IDS,
  AttackError,
  type AttackId,
  type DemoConfig,
  demoArmed,
  parseDemoConfig,
} from "./attacks.js";
import { demoConfigFromJourney, TESTNET_RPC } from "./demo-config.js";
import { AttackRelay, rpcChain } from "./relay.js";

/**
 * Owner tool of the attack console (M53). Read-only except `send`.
 *
 *   attack-console config --journey <run dir>/journey.json --attacker <account>
 *                         --key-file <attacker key file> [--rpc <url>] [--relay <url>] [--out <file>]
 *       Builds site/proof/attack/attack-demo.json from an attack-demo run. Loads the attacker key
 *       file with the relayer custody checks only to learn its public key, checks on chain (read-only) that the key is
 *       a function-call key restricted to the escrow, that the demo is armed and that the recorded
 *       approval bytes are those of the approval transaction, and records the key's nonce now as
 *       the baseline of the attempt counter.
 *
 *   attack-console send --config <file> --key-file <attacker key file> [--attack <id>|all]
 *                       [--rpc <url>] [--record]
 *       Sends attacks through the same relay code the hosted console runs (one transaction each,
 *       no rate limit between them) and prints what the escrow answered. With --record, every
 *       refused attempt is added to the config's `recorded` list, which the page replays when no
 *       relay is reachable.
 *
 * Exit status: 0 done, 1 an attempt was not refused (the console stops), 2 usage or a refusal.
 */

function flags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new AttackError("CONFIG_INVALID", `unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const need = (f: Record<string, string | true>, k: string): string => {
  const v = f[k];
  if (typeof v !== "string" || v === "") throw new AttackError("CONFIG_INVALID", `--${k} is required`);
  return v;
};

const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const say = (m: string) => process.stderr.write(`attack-console: ${m}\n`);

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const rpcUrl = typeof f["rpc"] === "string" ? f["rpc"] : TESTNET_RPC[0];
  const chain = rpcChain(rpcUrl);
  switch (cmd) {
    case "config": {
      const journey = JSON.parse(readFileSync(need(f, "journey"), "utf8"));
      const escrow = String(journey.contractId);
      const signer = KeyFileTxSigner.load({
        accountId: need(f, "attacker"),
        receiverId: escrow,
        keyFile: need(f, "key-file"),
      });
      const onChain = await signer.verifyOnChain(rpcChainView(rpcUrl));
      const config = demoConfigFromJourney(journey, {
        attacker: { accountId: signer.signerId, publicKey: signer.publicKey },
        baselineNonce: onChain.nonce,
        relay: typeof f["relay"] === "string" ? f["relay"] : null,
      });
      const relay = new AttackRelay({ config, chain, signer });
      const snap = await relay.snapshot();
      const armed = demoArmed(config, snap);
      if (!armed.armed) throw new AttackError("DEMO_NOT_ARMED", `the demo trade is not armed: ${armed.why}`);
      // The replay sends these bytes: they must be the accepted approval transaction's arguments.
      const approvalStep = config.setup.find((s) => s.step === "approval");
      const tx = await chain.txStatus(config.approval?.txHash as string, approvalStep?.signer as string);
      const sent = sentArgs(tx);
      if (sent !== config.approval?.argsBase64)
        throw new AttackError("DEMO_STALE", "the approval transaction on chain carries other argument bytes");
      const out = typeof f["out"] === "string" ? f["out"] : "site/proof/attack/attack-demo.json";
      writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
      say(
        `wrote ${out}: trade ${config.tradeId}, attacker ${signer.signerId}, baseline nonce ${config.baselineNonce}`,
      );
      return 0;
    }
    case "send": {
      const file = need(f, "config");
      const config: DemoConfig = parseDemoConfig(JSON.parse(readFileSync(file, "utf8")));
      const signer = KeyFileTxSigner.load({
        accountId: config.attacker?.accountId as string,
        receiverId: config.escrow as string,
        keyFile: need(f, "key-file"),
      });
      await signer.verifyOnChain(rpcChainView(rpcUrl));
      const relay = new AttackRelay({
        config,
        chain,
        signer,
        limits: { perClientMs: 0, windowMs: 60_000, windowMax: 10 },
      });
      const which =
        typeof f["attack"] === "string" && f["attack"] !== "all" ? [f["attack"]] : [...ATTACK_IDS];
      const recorded = [...config.recorded];
      let status = 0;
      for (const id of which) {
        if (!ATTACK_IDS.includes(id as AttackId))
          throw new AttackError("UNKNOWN_ATTACK", `unknown attack ${id}`);
        const r = await relay.attempt(id as AttackId, "owner");
        say(`${id.padEnd(20)} ${r.txHash} ${r.refused ? `REFUSED ${r.code}` : "NOT REFUSED"}`);
        print(r);
        if (!r.refused || !r.fundsUnchanged) {
          status = 1;
          break;
        }
        recorded.push({
          attack: r.attack,
          txHash: r.txHash,
          signer: r.signer,
          code: r.code,
          blockTimeMs: null,
        });
      }
      if (f["record"] === true) {
        writeFileSync(file, `${JSON.stringify({ ...config, recorded }, null, 2)}\n`);
        say(`recorded ${recorded.length} attempt(s) in ${file}`);
      }
      return status;
    }
    default:
      say("usage: attack-console config ... | send ... (see the header of this file)");
      return 2;
  }
}

/** The read-only RPC client the key check needs. */
function rpcChainView(endpoint: string): JsonRpcNearClient {
  return new JsonRpcNearClient({
    endpoint,
    allowedHosts: [new URL(endpoint).hostname],
    timeoutMs: 30_000,
    maxResponseBytes: 1024 * 1024,
  });
}

/** base64 argument bytes of the first function call of a transaction result. */
export function sentArgs(tx: Record<string, unknown>): string | null {
  const t = tx["transaction"] as { actions?: { FunctionCall?: { args?: unknown } }[] } | undefined;
  const call = (t?.actions ?? []).map((a) => a?.FunctionCall).find(Boolean);
  return typeof call?.args === "string" ? call.args : null;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    say(`${(e as { code?: string }).code ?? "ERROR"}: ${(e as Error).message}`);
    process.exit(2);
  },
);
