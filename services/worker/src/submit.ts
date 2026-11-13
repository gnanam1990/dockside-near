import { DocksideError, fail } from "@dockside/core";
import { type Journal, withRelayerKey } from "@dockside/journal";
import type { FunctionCall, NearTxClient, TxSigner } from "@dockside/near";

/**
 * Submits one party or service call with the relayer key (M43): the party relay and the
 * ManifestAttestor / deterministic-policy services use it. Every submission goes through the same
 * fenced `withRelayerKey` lease and durable nonce table as the outbox worker and the asset-recovery
 * engine (M15), so all of them can share one function-call key across processes without racing
 * nonces. These calls carry their own party or service signatures (the contract re-verifies them);
 * a lost response is reported as UNKNOWN with the transaction hash, never re-sent automatically.
 */

export interface RelayResult {
  readonly txHash: string;
  readonly outcome: "FINAL_SUCCESS" | "FINAL_FAILURE" | "EXECUTING" | "NOT_FOUND" | "UNKNOWN";
  readonly error: string | null;
  readonly method: string;
}

export interface SubmitterOptions {
  readonly holder: string;
  /** Lease TTL of the relayer key; must exceed one broadcast with `wait_until: FINAL`. */
  readonly leaseTtlMs: number;
  /** How long to wait for another submitter to release the key. */
  readonly waitMs: number;
}

export class RelayerSubmitter {
  constructor(
    private readonly journal: Journal,
    private readonly signer: TxSigner,
    private readonly tx: Pick<NearTxClient, "accessKeyNonce" | "latestBlock" | "send">,
    private readonly opts: SubmitterOptions,
  ) {}

  async submit(call: FunctionCall): Promise<RelayResult> {
    const until = Date.now() + this.opts.waitMs;
    for (;;) {
      const r = await withRelayerKey(
        this.journal,
        this.signer,
        this.opts.holder,
        this.opts.leaseTtlMs,
        () => this.tx.accessKeyNonce(this.signer.signerId, this.signer.publicKey),
        async (nonce): Promise<RelayResult> => {
          const block = await this.tx.latestBlock();
          const signed = await this.signer.sign(call, { nonce, blockHash: block.hash });
          try {
            const out = await this.tx.send(signed);
            return {
              txHash: signed.txHash,
              outcome: out.kind,
              error: out.kind === "NOT_FOUND" ? null : out.error,
              method: call.methodName,
            };
          } catch (e) {
            // The transaction may or may not have been included: report its hash, never resend.
            return {
              txHash: signed.txHash,
              outcome: "UNKNOWN",
              error: e instanceof DocksideError ? e.code : "TRANSPORT",
              method: call.methodName,
            };
          }
        },
      );
      if (r.ran) return r.value;
      if (Date.now() >= until) fail("RATE_LIMITED", "the relayer key is busy; try again shortly");
      await new Promise((res) => setTimeout(res, 200));
    }
  }
}
