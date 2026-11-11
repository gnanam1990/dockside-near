# services/worker

`@dockside/worker` runs the M05 journal engines: `WorkerLoop` delivers due outbox rows
(`OutboxWorker`) and then reconciles due operations (`Reconciler`) on a fixed interval, never
overlapping itself. All authority stays in the journal and the contract (ADR-0007, ADR-0009).

`src/main.ts` refuses to start (exit 78, `RELAYER_SIGNER_NOT_PROVISIONED`): submitting needs a
relayer `TxSigner` with real key custody, which this build does not provision. See
`docs/status/M07.md` for the steps that unblock it.
