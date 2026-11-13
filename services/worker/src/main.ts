import { loadConfig } from "@dockside/core";
import { startRuntime } from "./runtime.js";

/**
 * Worker entry point. Submitting a release or refund needs the relayer's function-call key, held
 * by the production `KeyFileTxSigner` (M43): `DOCKSIDE_RELAYER_ACCOUNT_ID` and the PATH of its
 * near-cli-rs key file in `DOCKSIDE_RELAYER_KEY_FILE`. Without them the process refuses to start
 * (exit 78) instead of running with a substitute signer. With them it runs the chain preflight and
 * the key custody checks first, and also refuses (exit 78) if any fails.
 * Runbook: docs/runbooks/testnet-product.md.
 */
const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
    // The variable name only (loadConfig never puts a value into its error).
    log({
      event: "worker.refused",
      code: err.code ?? "INTERNAL",
      message: err.message ?? null,
      ...err.details,
    });
    process.exitCode = 78;
    return;
  }
  if (config.DOCKSIDE_RELAYER_ACCOUNT_ID === undefined || config.DOCKSIDE_RELAYER_KEY_FILE === undefined) {
    log({
      event: "worker.blocked",
      reason: "RELAYER_SIGNER_NOT_PROVISIONED",
      network: config.DOCKSIDE_NETWORK,
      escrowContractConfigured: config.DOCKSIDE_ESCROW_CONTRACT_ID !== undefined,
      rpcConfigured: config.DOCKSIDE_NEAR_RPC_URL !== undefined,
    });
    process.exitCode = 78;
    return;
  }
  let rt: Awaited<ReturnType<typeof startRuntime>>;
  try {
    rt = await startRuntime(config, log);
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
    // Codes, reasons and messages only: no configuration value or key material is echoed.
    log({
      event: "worker.refused",
      code: err.code ?? "INTERNAL",
      reason: err.details?.["reason"] ?? null,
      message: err.message ?? null,
    });
    process.exitCode = 78;
    return;
  }
  log({
    event: "worker.started",
    network: config.DOCKSIDE_NETWORK,
    chainId: rt.preflight.chainId,
    escrow: rt.preflight.escrowId,
    codeHash: rt.preflight.codeHash,
    relayer: rt.relayer.accountId,
    relayerPublicKey: rt.relayer.publicKey,
    relayPort: rt.relayPort,
    services: {
      manifestAttestor: config.DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE !== undefined,
      deterministicPolicy: config.DOCKSIDE_POLICY_SERVICE_KEY_FILE !== undefined,
    },
  });
  const stop = () => {
    void rt.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
