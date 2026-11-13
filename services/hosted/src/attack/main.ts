import { appendFileSync, readFileSync } from "node:fs";
import { JsonRpcNearClient, KeyFileTxSigner } from "@dockside/near";
import { AttackError, type DemoConfig, parseDemoConfig } from "./attacks.js";
import { AttackRelay, rpcChain } from "./relay.js";
import { createAttackServer } from "./server.js";

/**
 * The attack relay process of a hosted deployment (M53), started by the hosted launcher on
 * loopback. Its environment is built by the launcher:
 *
 *   HOSTED_ATTACK_PORT             loopback port
 *   HOSTED_ATTACK_CONFIG           site/proof/attack/attack-demo.json of the image
 *   HOSTED_ATTACK_KEY_FILE         private copy of the demo account's function-call key file (optional)
 *   HOSTED_ATTACK_LOG              JSON-lines log of sent attempts on the data volume
 *   HOSTED_ATTACK_ALLOWED_ORIGINS  comma-separated origins that may call cross-origin (optional)
 *   DOCKSIDE_NEAR_RPC_URL          the chain
 *
 * It never ends the container: without a live demo config or a usable key it answers RELAY_OFF,
 * and the page replays recorded attempts instead. The key must be a function-call key of the
 * config's attacker account restricted to the escrow (checked on chain before the first attempt).
 */

const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function relayFromEnv(env: NodeJS.ProcessEnv): Promise<{ relay: AttackRelay | null; off: string }> {
  let config: DemoConfig;
  try {
    config = parseDemoConfig(JSON.parse(readFileSync(String(env["HOSTED_ATTACK_CONFIG"]), "utf8")));
  } catch (e) {
    return { relay: null, off: `the demo config is unreadable: ${(e as Error).message}` };
  }
  if (config.status !== "LIVE") return { relay: null, off: "the demo trade has not been created yet" };
  const keyFile = env["HOSTED_ATTACK_KEY_FILE"];
  if (!keyFile) return { relay: null, off: "no demo key is configured on this deployment" };
  const rpcUrl = String(env["DOCKSIDE_NEAR_RPC_URL"]);
  try {
    const signer = KeyFileTxSigner.load({
      accountId: config.attacker?.accountId as string,
      receiverId: config.escrow as string,
      keyFile,
    });
    await signer.verifyOnChain(
      new JsonRpcNearClient({
        endpoint: rpcUrl,
        allowedHosts: [new URL(rpcUrl).hostname],
        timeoutMs: 30_000,
        maxResponseBytes: 1024 * 1024,
      }),
    );
    const logFile = env["HOSTED_ATTACK_LOG"];
    const relay = new AttackRelay({
      config,
      chain: rpcChain(rpcUrl),
      signer,
      onAttempt: (r) => {
        log({
          event: "attack.attempt",
          attack: r.attack,
          txHash: r.txHash,
          refused: r.refused,
          code: r.code,
        });
        if (logFile) appendFileSync(logFile, `${JSON.stringify(r)}\n`, { mode: 0o600 });
      },
    });
    log({
      event: "attack.armed",
      attacker: signer.signerId,
      publicKey: signer.publicKey,
      tradeId: config.tradeId,
    });
    return { relay, off: "" };
  } catch (e) {
    const code = e instanceof AttackError ? e.code : ((e as { code?: string }).code ?? "ERROR");
    const reason = (e as { details?: { reason?: string } }).details?.reason ?? null;
    // A code and a reason, never key material.
    log({ event: "attack.key_refused", code, reason });
    return { relay: null, off: "the demo key on this deployment was refused" };
  }
}

async function main(): Promise<void> {
  const port = Number(process.env["HOSTED_ATTACK_PORT"] ?? "8789");
  const { relay, off } = await relayFromEnv(process.env);
  const allowedOrigins = String(process.env["HOSTED_ATTACK_ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const server = createAttackServer({ relay, offReason: off, allowedOrigins });
  server.listen(port, "127.0.0.1", () => {
    log({ event: "attack.listening", port, relay: relay ? "on" : "off", ...(relay ? {} : { why: off }) });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
