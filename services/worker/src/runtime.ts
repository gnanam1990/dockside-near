import { AuthorityService, IsolatedSigner } from "@dockside/authority";
import { type DocksideConfig, randomIds, systemClock } from "@dockside/core";
import { EvidenceService, HoldService, LocalObjectStore } from "@dockside/evidence";
import {
  AssetRecoveryEngine,
  AssetRecoveryJournal,
  DEFAULT_ENGINE_CONFIG,
  Journal,
  OutboxWorker,
  Reconciler,
} from "@dockside/journal";
import {
  EscrowContract,
  JsonRpcNearClient,
  KeyFileTxSigner,
  NearTxClient,
  Nep141Reader,
  type PreflightResult,
  preflightEscrow,
} from "@dockside/near";
import { Database } from "@dockside/store";
import { WorkerLoop } from "./index.js";
import { PartyRelay } from "./relay.js";
import { ServiceLoops } from "./services.js";
import { RelayerSubmitter } from "./submit.js";

/**
 * Real-chain worker runtime (M43): the M05 outbox worker and reconciler and the M11 asset engine
 * with the production relayer signer, plus the party relay and the ManifestAttestor /
 * deterministic-policy services, all against a NEAR node (NEAR testnet, or a local near-sandbox in
 * the tests). Startup order is fail-closed: configuration, chain preflight (not mainnet, the escrow
 * runs exactly the manifest's code), key file custody checks, then the on-chain check that the
 * relayer key is a function-call key restricted to the escrow. Only then is anything signed.
 */

export type Log = (line: Record<string, string | number | null>) => void;

export interface RuntimeHandle {
  readonly preflight: PreflightResult;
  readonly relayer: { readonly accountId: string; readonly publicKey: string };
  readonly relayPort: number | null;
  stop(): Promise<void>;
}

export function rpcClient(endpoint: string, timeoutMs: number): JsonRpcNearClient {
  return new JsonRpcNearClient({
    endpoint,
    allowedHosts: [new URL(endpoint).hostname],
    timeoutMs,
    maxResponseBytes: 4 * 1024 * 1024,
  });
}

/** The chain preflight both the API and the worker run before serving a real chain. */
export async function chainPreflight(config: DocksideConfig): Promise<PreflightResult> {
  const escrowId = config.DOCKSIDE_ESCROW_CONTRACT_ID;
  const rpcUrl = config.DOCKSIDE_NEAR_RPC_URL;
  const manifest = config.DOCKSIDE_ESCROW_MANIFEST;
  if (escrowId === undefined || rpcUrl === undefined)
    throw Object.assign(new Error("DOCKSIDE_ESCROW_CONTRACT_ID and DOCKSIDE_NEAR_RPC_URL are required"), {
      code: "CONFIG_INVALID",
    });
  if (manifest === undefined)
    throw Object.assign(new Error("DOCKSIDE_ESCROW_MANIFEST is required to check the escrow's code hash"), {
      code: "CONFIG_INVALID",
    });
  return preflightEscrow({
    rpc: rpcClient(rpcUrl, 15_000),
    rpcUrl,
    escrowId,
    manifestPath: manifest,
    expectedChainId: config.DOCKSIDE_NEAR_CHAIN_ID,
  });
}

export async function startRuntime(config: DocksideConfig, log: Log): Promise<RuntimeHandle> {
  const preflight = await chainPreflight(config);
  const escrowId = preflight.escrowId;
  const rpcUrl = config.DOCKSIDE_NEAR_RPC_URL as string;
  const relayerAccount = config.DOCKSIDE_RELAYER_ACCOUNT_ID as string;
  const signer = KeyFileTxSigner.load({
    accountId: relayerAccount,
    receiverId: escrowId,
    keyFile: config.DOCKSIDE_RELAYER_KEY_FILE as string,
  });
  // Views use a short timeout; broadcasts wait for FINAL, which takes longer on testnet.
  const views = rpcClient(rpcUrl, 15_000);
  const sends = rpcClient(rpcUrl, 60_000);
  await signer.verifyOnChain(views);

  const db = Database.open(config.DOCKSIDE_DB_PATH);
  db.migrate();
  const escrow = new EscrowContract(views, escrowId);
  const tx = new NearTxClient(sends);
  const ports = { escrow, tx, txValidityBlocks: config.DOCKSIDE_TX_VALIDITY_BLOCKS };
  const holder = `worker-${process.pid}`;
  const engineCfg = { holder, ...DEFAULT_ENGINE_CONFIG, leaseTtlMs: 120_000 };
  const journal = new Journal(db, systemClock, randomIds);
  const reconciler = new Reconciler(journal, ports, engineCfg);
  const assetEngine = new AssetRecoveryEngine(
    new AssetRecoveryJournal(db, systemClock, randomIds),
    { ...ports, token: (c: string) => new Nep141Reader(views, c) },
    signer,
    { holder, leaseTtlMs: 120_000, baseBackoffMs: 2_000, maxBackoffMs: 60_000 },
  );
  const loop = new WorkerLoop({
    worker: new OutboxWorker(journal, ports, signer, reconciler, engineCfg),
    reconciler,
    engines: [assetEngine],
    intervalMs: config.DOCKSIDE_WORKER_INTERVAL_MS,
    log,
  });
  const submitter = new RelayerSubmitter(journal, signer, tx, {
    holder: `${holder}-relay`,
    leaseTtlMs: 120_000,
    waitMs: 90_000,
  });
  const submit = (call: Parameters<RelayerSubmitter["submit"]>[0]) => submitter.submit(call);

  // ManifestAttestor and deterministic-policy services, each key in its own isolated signer process.
  const children: IsolatedSigner[] = [];
  let services: ServiceLoops | null = null;
  let servicesTimer: NodeJS.Timeout | null = null;
  const attestorFile = config.DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE;
  const policyFile = config.DOCKSIDE_POLICY_SERVICE_KEY_FILE;
  if (attestorFile !== undefined || policyFile !== undefined) {
    const attestor =
      attestorFile === undefined
        ? null
        : await IsolatedSigner.spawn({
            allowedPurposes: ["SERVICE_POP_CHALLENGE", "MANIFEST_ATTESTATION"],
            seedFile: attestorFile,
          });
    const policy =
      policyFile === undefined
        ? null
        : await IsolatedSigner.spawn({
            allowedPurposes: ["SERVICE_POP_CHALLENGE", "HOLD_SET"],
            seedFile: policyFile,
          });
    for (const c of [attestor, policy]) if (c) children.push(c);
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
        requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
      },
    });
    const deps = { db, clock: systemClock, ids: randomIds, authority };
    const evidence = new EvidenceService({
      ...deps,
      objects: new LocalObjectStore(config.DOCKSIDE_OBJECT_STORE_DIR, `worker-${process.pid}-${Date.now()}`),
    });
    const holds = new HoldService({ ...deps, evidence });
    services = new ServiceLoops({ db, evidence, holds, escrow, attestor, policy, submit, log });
    const tick = () => {
      void services?.runOnce().finally(() => {
        if (servicesTimer) servicesTimer = setTimeout(tick, config.DOCKSIDE_WORKER_INTERVAL_MS);
      });
    };
    servicesTimer = setTimeout(tick, 0);
  }

  let relay: PartyRelay | null = null;
  let relayPort: number | null = null;
  if (config.DOCKSIDE_RELAY_PORT !== undefined) {
    relay = new PartyRelay({
      escrowId,
      origin: config.DOCKSIDE_ORIGIN,
      status: {
        relayer: signer.signerId,
        contractId: escrowId,
        network: config.DOCKSIDE_NETWORK,
        chain: preflight.chainId === "testnet" ? "NEAR_TESTNET" : `NEAR_${preflight.chainId.toUpperCase()}`,
        note: `function-call key ${signer.publicKey} restricted to ${escrowId}; the contract re-verifies every signature in the call.`,
      },
      submit,
      log,
    });
    relayPort = await relay.listen(config.DOCKSIDE_RELAY_PORT);
  }
  loop.start();
  return {
    preflight,
    relayer: { accountId: signer.signerId, publicKey: signer.publicKey },
    relayPort,
    async stop() {
      if (servicesTimer) clearTimeout(servicesTimer);
      servicesTimer = null;
      await relay?.close();
      await loop.stop();
      for (const c of children) c.close();
      db.close();
    },
  };
}
