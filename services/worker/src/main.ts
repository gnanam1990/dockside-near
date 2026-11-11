import { loadConfig } from "@dockside/core";

/**
 * Worker entry point. Submitting a release or refund needs a relayer key held by a TxSigner with
 * real custody (HSM, KMS or an isolated signer with a provisioned testnet account). None is
 * provisioned in this build, so the process refuses to start instead of running with a
 * substitute signer. See docs/status/M07.md for the user steps that unblock it.
 */
function main(): void {
  const config = loadConfig(process.env);
  process.stdout.write(
    `${JSON.stringify({
      event: "worker.blocked",
      reason: "RELAYER_SIGNER_NOT_PROVISIONED",
      network: config.DOCKSIDE_NETWORK,
      escrowContractConfigured: config.DOCKSIDE_ESCROW_CONTRACT_ID !== undefined,
      rpcConfigured: config.DOCKSIDE_NEAR_RPC_URL !== undefined,
    })}\n`,
  );
  process.exitCode = 78;
}

main();
