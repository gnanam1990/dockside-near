import type { TxSigner } from "@dockside/near";
import type { Journal, Lease } from "./journal.js";

/**
 * One relayer access key, many submitters (M15). The release/refund outbox worker and the
 * asset-recovery engine sign with the same relayer key, possibly in several worker processes.
 * NEAR accepts a transaction only with a nonce above the access key's current nonce, so two
 * submitters that read the same chain nonce, or that broadcast out of order, make one of the two
 * transactions unincludable (it then waits in UNKNOWN until its validity window lapses).
 *
 * `withRelayerKey` serializes sign-persist-broadcast per access key behind a fenced lease and
 * allocates the nonce durably: above the chain's nonce and above every nonce already handed out,
 * so a transaction persisted by a process that died before broadcasting never shares its nonce
 * with a later one. When another submitter holds the key, nothing is signed and the caller
 * retries on a later tick.
 */
export async function withRelayerKey<T>(
  journal: Journal,
  signer: Pick<TxSigner, "signerId" | "publicKey">,
  holder: string,
  ttlMs: number,
  chainNonce: () => Promise<bigint>,
  fn: (nonce: bigint, key: Lease) => Promise<T>,
): Promise<{ readonly ran: true; readonly value: T } | { readonly ran: false }> {
  const key = journal.acquireLease(`relayer-key:${signer.signerId}:${signer.publicKey}`, holder, ttlMs);
  if (!key) return { ran: false };
  try {
    const onChain = await chainNonce();
    const nonce = journal.db.transaction(() => {
      journal.fence(key);
      const r = journal.db.get(
        "SELECT last_nonce FROM relayer_nonces WHERE signer_id = ? AND public_key = ?",
        signer.signerId,
        signer.publicKey,
      );
      const last = r ? BigInt(String(r["last_nonce"])) : 0n;
      const next = (onChain > last ? onChain : last) + 1n;
      journal.db.run(
        `INSERT INTO relayer_nonces (signer_id, public_key, last_nonce, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (signer_id, public_key) DO UPDATE SET last_nonce = excluded.last_nonce, updated_at = excluded.updated_at`,
        signer.signerId,
        signer.publicKey,
        next.toString(10),
        journal.clock.now(),
      );
      return next;
    });
    return { ran: true, value: await fn(nonce, key) };
  } finally {
    journal.releaseLease(key);
  }
}
