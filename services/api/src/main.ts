import { createServer } from "node:http";
import { AuthorityService, IsolatedSigner } from "@dockside/authority";
import { type DocksideConfig, loadConfig, randomIds, redactConfig, systemClock } from "@dockside/core";
import { EvidenceService, HoldService, LocalObjectStore } from "@dockside/evidence";
import { AssetRecoveryJournal, JournalService } from "@dockside/journal";
import { EscrowContract, JsonRpcNearClient, NearTxClient, Nep141Reader } from "@dockside/near";
import { BlockedOneClickAdapter } from "@dockside/payout";
import { ReleaseService } from "@dockside/release";
import { Database } from "@dockside/store";
import { createApp, type ExportKeySigner, enrollExportKey, hardenServer } from "./app.js";
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

/** Chain adapter for NEAR account ownership checks and the RPC connection test (M17). */
function chainAdapter(config: DocksideConfig) {
  const endpoint = config.DOCKSIDE_NEAR_RPC_URL;
  if (endpoint === undefined) return undefined;
  const rpc = new JsonRpcNearClient({
    endpoint,
    allowedHosts: [new URL(endpoint).hostname],
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
  });
  return { rpc, tx: new NearTxClient(rpc) };
}

/**
 * The dedicated audit-export key (ADR-0018): read only by an isolated signer child process that may
 * sign the enrollment proof and export statements, nothing else. Enrolled (or confirmed) at startup.
 */
async function exportSigner(config: DocksideConfig, db: Database): Promise<ExportKeySigner | undefined> {
  const file = config.DOCKSIDE_AUDIT_EXPORT_KEY_FILE;
  if (file === undefined) return undefined;
  const signer = await IsolatedSigner.spawn({
    allowedPurposes: ["AUDIT_EXPORT_KEY_ENROLLMENT", "AUDIT_EXPORT"],
    seedFile: file,
  });
  const s: ExportKeySigner = {
    publicKey: signer.publicKey,
    custodyKind: "ISOLATED_SIGNER_PROCESS",
    sign: (purpose, payload) => signer.sign(purpose, payload),
  };
  await enrollExportKey(
    {
      db,
      clock: systemClock,
      ids: randomIds,
      origin: config.DOCKSIDE_ORIGIN,
      network: config.DOCKSIDE_NETWORK,
    },
    s,
  );
  return s;
}

/** Local entry point. Configuration comes only from DOCKSIDE_* environment variables. */
async function main(): Promise<void> {
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
  const chain = chainAdapter(config);
  const signer = await exportSigner(config, db);
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
        ...(chain ? { chain } : {}),
        ...(signer ? { exportSigner: signer } : {}),
        oneClick: new BlockedOneClickAdapter(),
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
      auditExportKey: signer ? signer.publicKey : "NOT_CONFIGURED",
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

main().catch((e: unknown) => {
  process.stderr.write(
    `api failed to start: ${(e as { code?: string }).code ?? "INTERNAL"}: ${(e as Error).message}\n`,
  );
  process.exit(1);
});
