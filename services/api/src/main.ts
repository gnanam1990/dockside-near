import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { AuthorityService, IsolatedSigner } from "@dockside/authority";
import { type DocksideConfig, loadConfig, randomIds, redactConfig, systemClock } from "@dockside/core";
import { EvidenceService, HoldService, LocalObjectStore } from "@dockside/evidence";
import { AssetRecoveryJournal, JournalService } from "@dockside/journal";
import {
  EscrowContract,
  JsonRpcNearClient,
  NearTxClient,
  Nep141Reader,
  type PreflightResult,
  preflightEscrow,
} from "@dockside/near";
import { BlockedOneClickAdapter, OneClickClient } from "@dockside/payout";
import { ReleaseService } from "@dockside/release";
import { Database } from "@dockside/store";
import { type CashOutModule, createApp, type ExportKeySigner, enrollExportKey, hardenServer } from "./app.js";
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
 * Supplier cash-out (M52, ADR-0028): a 1Click client that can only list tokens, ask for dry quotes
 * and read statuses, plus read-only NEAR access to reconcile a deposit. No signer is involved.
 */
function cashOutModule(config: DocksideConfig): CashOutModule | undefined {
  const url = config.DOCKSIDE_ONE_CLICK_URL;
  const endpoint = config.DOCKSIDE_NEAR_RPC_URL;
  if (url === undefined || endpoint === undefined) return undefined;
  const rpc = new JsonRpcNearClient({
    endpoint,
    allowedHosts: [new URL(endpoint).hostname],
    timeoutMs: 10_000,
    maxResponseBytes: 4 * 1024 * 1024,
  });
  const tokenFile = config.DOCKSIDE_ONE_CLICK_TOKEN_FILE;
  let bearer: string | undefined;
  if (tokenFile !== undefined) {
    let raw = "";
    try {
      raw = readFileSync(tokenFile, "utf8").trim();
    } catch {
      raw = "";
    }
    // Only the variable's name is ever reported, never the path's content.
    if (!/^[A-Za-z0-9._~+/=-]{16,4096}$/.test(raw))
      throw Object.assign(new Error("the 1Click token file is missing or not a token"), {
        code: "CONFIG_INVALID",
        details: { name: "DOCKSIDE_ONE_CLICK_TOKEN_FILE" },
      });
    bearer = raw;
  }
  return {
    client: new OneClickClient({ baseUrl: url, timeoutMs: 10_000, ...(bearer ? { bearer } : {}) }),
    nearNetwork: config.DOCKSIDE_ONE_CLICK_NEAR_NETWORK,
    tx: new NearTxClient(rpc),
    token: (contract: string) => new Nep141Reader(rpc, contract),
  };
}

/**
 * The dedicated audit-export key (ADR-0018): read only by an isolated signer child process that may
 * sign the enrollment proof, export statements and payment receipts (M54), nothing else. Enrolled (or confirmed) at startup.
 */
async function exportSigner(config: DocksideConfig, db: Database): Promise<ExportKeySigner | undefined> {
  const file = config.DOCKSIDE_AUDIT_EXPORT_KEY_FILE;
  if (file === undefined) return undefined;
  const signer = await IsolatedSigner.spawn({
    allowedPurposes: ["AUDIT_EXPORT_KEY_ENROLLMENT", "AUDIT_EXPORT", "PAYMENT_RECEIPT"],
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

/**
 * Chain preflight (M43): before serving trade routes against a NEAR node, prove it is not mainnet,
 * is the configured chain, and that the escrow runs exactly the code the manifest names. Runs before
 * the database is opened, so a refused start creates nothing.
 */
async function chainPreflight(config: DocksideConfig): Promise<PreflightResult | null> {
  const escrowId = config.DOCKSIDE_ESCROW_CONTRACT_ID;
  const endpoint = config.DOCKSIDE_NEAR_RPC_URL;
  if (escrowId === undefined || endpoint === undefined) return null;
  const manifestPath = config.DOCKSIDE_ESCROW_MANIFEST;
  if (manifestPath === undefined)
    throw Object.assign(new Error("DOCKSIDE_ESCROW_MANIFEST is required to check the escrow's code hash"), {
      code: "CONFIG_INVALID",
    });
  return preflightEscrow({
    rpc: new JsonRpcNearClient({
      endpoint,
      allowedHosts: [new URL(endpoint).hostname],
      timeoutMs: 15_000,
      maxResponseBytes: 4 * 1024 * 1024,
    }),
    rpcUrl: endpoint,
    escrowId,
    manifestPath,
    expectedChainId: config.DOCKSIDE_NEAR_CHAIN_ID,
  });
}

/** Local entry point. Configuration comes only from DOCKSIDE_* environment variables. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const preflight = await chainPreflight(config);
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
  const cashOut = cashOutModule(config);
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
        ...(cashOut ? { cashOut } : {}),
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
      chain: preflight
        ? { chainId: preflight.chainId, escrow: preflight.escrowId, codeHash: preflight.codeHash }
        : "NOT_CONFIGURED",
      auditExportKey: signer ? signer.publicKey : "NOT_CONFIGURED",
      cashOut: cashOut
        ? { provider: cashOut.client.baseUrl, network: cashOut.nearNetwork }
        : "NOT_CONFIGURED",
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
  const d = (e as { details?: { reason?: unknown; name?: unknown } }).details;
  // A reason code or the configuration variable's name; never a value.
  const tag = typeof d?.reason === "string" ? d.reason : typeof d?.name === "string" ? d.name : null;
  const why = tag ? ` (${tag})` : "";
  process.stderr.write(
    `api failed to start: ${(e as { code?: string }).code ?? "INTERNAL"}${why}: ${(e as Error).message}\n`,
  );
  process.exit(1);
});
