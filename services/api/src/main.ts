import { createServer } from "node:http";
import { AuthorityService } from "@dockside/authority";
import { type DocksideConfig, loadConfig, randomIds, redactConfig, systemClock } from "@dockside/core";
import { EvidenceService, HoldService, LocalObjectStore } from "@dockside/evidence";
import { AssetRecoveryJournal, JournalService } from "@dockside/journal";
import { EscrowContract, JsonRpcNearClient, NearTxClient, Nep141Reader } from "@dockside/near";
import { ReleaseService } from "@dockside/release";
import { Database } from "@dockside/store";
import { createApp, hardenServer } from "./app.js";
import type { TradeModules } from "./trades.js";

/**
 * Trade modules need an escrow contract and a NEAR RPC endpoint. Without both, the API serves the
 * M01 authority surface only and trade routes answer "no such endpoint" (never invented data).
 */
function tradeModules(
  config: DocksideConfig,
  db: Database,
  authority: AuthorityService,
): TradeModules | undefined {
  const contract = config.DOCKSIDE_ESCROW_CONTRACT_ID;
  const endpoint = config.DOCKSIDE_NEAR_RPC_URL;
  if (contract === undefined || endpoint === undefined) return undefined;
  const rpc = new JsonRpcNearClient({
    endpoint,
    allowedHosts: [new URL(endpoint).hostname],
    timeoutMs: 10_000,
    maxResponseBytes: 4 * 1024 * 1024,
  });
  const escrow = new EscrowContract(rpc, contract);
  const deps = { db, clock: systemClock, ids: randomIds, authority };
  const evidence = new EvidenceService({
    ...deps,
    objects: new LocalObjectStore(config.DOCKSIDE_OBJECT_STORE_DIR, `api-${process.pid}-${Date.now()}`),
  });
  const holds = new HoldService({ ...deps, evidence });
  const release = new ReleaseService({ ...deps, evidence, holds, escrow });
  const journal = new JournalService({ db, clock: systemClock, ids: randomIds, escrow, release });
  // Unexpected-asset recovery (M11): token views and transfer lookups use the same RPC endpoint.
  // Execution is queued here; only a worker with a provisioned relayer signer submits it.
  const assetRecovery = {
    journal: new AssetRecoveryJournal(db, systemClock, randomIds),
    token: (assetContract: string) => new Nep141Reader(rpc, assetContract),
    tx: new NearTxClient(rpc),
  };
  return { evidence, holds, release, journal, escrow, assetRecovery, chain: assetRecovery.tx };
}

/** Local entry point. Configuration comes only from DOCKSIDE_* environment variables. */
function main(): void {
  const config = loadConfig(process.env);
  const db = Database.open(config.DOCKSIDE_DB_PATH);
  const migrated = db.migrate();
  const authority = new AuthorityService({
    db,
    clock: systemClock,
    ids: randomIds,
    config: {
      origin: config.DOCKSIDE_ORIGIN,
      network: config.DOCKSIDE_NETWORK,
      challengeTtlMs: config.DOCKSIDE_CHALLENGE_TTL_MS,
      sessionTtlMs: config.DOCKSIDE_SESSION_TTL_MS,
      invitationTtlMs: config.DOCKSIDE_INVITATION_TTL_MS,
      recoveryDelayMs: config.DOCKSIDE_RECOVERY_DELAY_MS,
      ...(config.DOCKSIDE_RECOVERY_CHALLENGE_TTL_MS === undefined
        ? {}
        : { recoveryChallengeTtlMs: config.DOCKSIDE_RECOVERY_CHALLENGE_TTL_MS }),
      requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
    },
  });
  const modules = tradeModules(config, db, authority);
  const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const server = hardenServer(
    createServer(
      createApp({
        config,
        db,
        authority,
        clock: systemClock,
        ids: randomIds,
        log,
        ...(modules ? { modules } : {}),
      }),
    ),
  );
  server.listen(config.DOCKSIDE_PORT, config.DOCKSIDE_HOST, () => {
    const addr = server.address();
    log({
      event: "listening",
      address: addr,
      migrationsApplied: migrated.applied,
      tradeModules: modules ? "CONFIGURED" : "NOT_CONFIGURED",
      config: redactConfig(config),
    });
  });
  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
