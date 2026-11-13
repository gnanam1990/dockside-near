# ADR-0025 — Relayer signer custody and the real-chain runtime profile

- Decision status: accepted
- Date: 2026-11-13, Dockside platform team
- Affected IDs: NFR-02, INV-13 (unchanged), T-007, T-019, T-035, T-044
- Relates to: ADR-0003 (service custody), ADR-0007 (journal, outbox, reconciliation), ADR-0009 decision 11
  (worker refused to start), ADR-0015 (reproducible wasm), ADR-0018 (isolated signer processes), ADR-0019
  (sandbox suites)

## Context

Until M43 the API, worker and web app had only ever run against the simulated chain: the worker exited 78
(`RELAYER_SIGNER_NOT_PROVISIONED`) because no `TxSigner` with real key custody existed, the party relay existed
only in the local stack, and nothing checked that a configured escrow ran the reviewed code. The hardened escrow is
deployed on NEAR testnet (`gnanam1990-dock-escrow2.testnet`, code hash `7GEti5E6…5h8N`, M34) with a relayer
function-call key restricted to it.

## Decisions

1. **Own transaction encoder, no NEAR SDK.** `packages/near/src/near-tx.ts` writes nearcore's borsh
   `Transaction::V0` / `SignedTransaction` with node:crypto Ed25519 (only the actions Dockside needs; anything else
   is refused). The transaction hash is `base58(sha256(borsh(tx)))`, the signature is over it. Checked against the
   published near-api-js serialization vector and accepted by nearcore in the sandbox suites. No third-party code
   handles the relayer key.
2. **`KeyFileTxSigner`** (`packages/near/src/relayer-signer.ts`) implements the existing `TxSigner` exactly like the
   simulated signer (`sign(call, {nonce, blockHash}) → {txHash, signerId, encoded}`, deterministic). Custody:
   - the key comes only from a near-cli-rs key file; configuration holds its PATH (`DOCKSIDE_RELAYER_KEY_FILE`),
     never the key;
   - the file must be a regular file (no symlink), ≤ 4 KiB, outside any git working tree, owner-readable only
     (POSIX `0600`/`0400` and owned by the user; Windows: no `Everyone`, `Users` or `Authenticated Users` ACL
     entry via `icacls`);
   - the private key lives in a `KeyObject` in a private field; `toJSON` and `util.inspect` show only account and
     public key; it is never logged and never crosses HTTP;
   - it signs only calls to the configured escrow with zero deposit, and at startup the chain must report the key
     as a function-call key whose receiver is the escrow — a full-access key is refused.
3. **Nonces and idempotency stay with the journal.** All submitters — outbox worker, reconciler, asset engine,
   party relay and the attestor/policy services — go through `withRelayerKey` (fenced lease plus durable nonce
   table, M15), so one function-call key is shared across processes without nonce races. The outbox's
   persist-then-broadcast and reconcile-by-original-hash are unchanged; a re-broadcast is byte-identical.
4. **Party relay in the worker.** `/relay/v1/*` (loopback only, proxied by the web server) relays an allowlist of
   escrow methods whose authority is a signature in the arguments, with no deposit, JSON only, Origin equal to the
   web origin when present, 60 calls a minute. `fund` and the unexpected-asset sender calls are refused: the
   party's own wallet sends them. The web app's funding panel shows the exact `fund` call and a near-cli-rs command
   for the buyer's keychain.
5. **Chain preflight.** The API and the worker refuse to start against a NEAR node unless `status.chain_id` equals
   `DOCKSIDE_NEAR_CHAIN_ID` (default `testnet`; another id only on a loopback RPC), the escrow's code hash equals the
   manifest's (`DOCKSIDE_ESCROW_MANIFEST`: a build manifest or the M34 artifact record), and `get_config` reports
   `near-testnet`. Mainnet is refused by configuration, RPC host, chain id and escrow account suffix.
6. **Services on a real chain.** The ManifestAttestor and deterministic-policy keys are seed files read only by
   isolated signer children in the worker; `pnpm run service-key` generates them and signs the enrolment
   proof-of-possession challenge after recomputing its digest. Administrators register an organisation's first
   EvidencePolicy in the web app (Organization → Policies).
7. **Validation without testnet transactions.** The same profile runs in the browser against a local nearcore
   sandbox deployed like testnet (`pnpm run web:e2e:sandbox`); the signer, nonce sharing and preflight run against
   nearcore in `pnpm run test:sandbox`. Running on testnet is the owner's step (docs/runbooks/testnet-product.md).

## Consequences

The worker runs whenever a relayer key file is configured and every check passes; without one it still exits 78.
HSM/KMS custody is a different `TxSigner` behind the same interface. The OS credential store of near-cli-rs (as
opposed to its legacy keychain files) is not read; keys kept only there must be saved as a legacy-keychain file.
A relay response that is lost is reported as `UNKNOWN` with the transaction hash and is not resent automatically.
