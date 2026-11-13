# services/worker

`@dockside/worker` runs the M05 journal engines: `WorkerLoop` delivers due outbox rows
(`OutboxWorker`) and then reconciles due operations (`Reconciler`) on a fixed interval, never
overlapping itself. All authority stays in the journal and the contract (ADR-0007, ADR-0009).

`src/main.ts` (`pnpm run worker`) refuses to start (exit 78, `RELAYER_SIGNER_NOT_PROVISIONED`) unless
`DOCKSIDE_RELAYER_ACCOUNT_ID` and `DOCKSIDE_RELAYER_KEY_FILE` (the path of the relayer's near-cli-rs
function-call key file) are set. With them (M43, ADR-0025) it runs the chain preflight and the key
custody checks, then the outbox worker, reconciler and asset engine with the production
`KeyFileTxSigner`, the party relay on loopback (`DOCKSIDE_RELAY_PORT`) and, when their seed files are
configured, the ManifestAttestor and deterministic-policy services. Any refusal exits 78 with a reason
code. Runbook: [docs/runbooks/testnet-product.md](../../docs/runbooks/testnet-product.md).
