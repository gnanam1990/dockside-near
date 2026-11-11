# M05 — Durable journal and reconciliation

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependency: M04.

Mapped IDs: FR-08, NFR-01, NFR-06, INV-02, INV-06, INV-07, INV-08, INV-09, INV-12, T-028, T-029, T-030, T-031, T-032, T-056, T-057.

Implement transactionally persisted release/refund intents, source buckets, child quotes/attempts, outbox, fenced leases, monotonic observations and provider/source/destination/refund reconciliation. `UNKNOWN`, `REVIEW`, `RECONCILING`, and `ADJUDICATION` retain locks; manual adjudication cannot force terminal status. FAILED requires authoritative non-transfer plus escrow proof, exact ledger restoration, invalidated old authority and a new intent/fresh approval for retry. Late success/refund and contradictions bind the original identity, freeze successors when needed and never authorize a second payout. Refund revocation restores the exact bucket, including excess to `QUARANTINED`.

Kill processes at every release/refund persistence, effect, UNKNOWN, REVIEW, reconciliation and adjudication boundary; race workers and deliver duplicate/late/contradictory/failure evidence. Prove restart without resubmit, authoritative failure disposition, fresh-new-intent rules and no bucket drift. Provider success alone is not PAID.
