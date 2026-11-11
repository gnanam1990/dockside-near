# ADR-0009 — Integrated trade API, server-side authority and audit export

- Decision status: accepted (M07)
- Date: 2026-11-11, Dockside build stage M07
- Affected IDs: FR-09, FR-10, FR-15, NFR-02, NFR-04, NFR-06, INV-01, INV-07, INV-08, INV-13, T-003, T-033,
  T-034, T-035, T-052, T-053; consumed by M08 (UI) and M09 (hardening); M06 interfaces only

## Context

M01 shipped the authority HTTP surface. M03, M04 and M05 shipped the evidence, hold, release and journal
services with no HTTP routes; the web shell (ADR-0008) had a catalog of planned routes that answered
"no such endpoint". M07 has to expose those services without weakening any authority the services or
the contract already enforce, and add an audit export that can be checked after transport.

## Decisions

1. **Three authority layers, all server side, in a fixed order.** Every trade route requires (a) an
   authenticated PoP session (M01: session token plus a fresh per-request Ed25519 proof over origin,
   method, path, body digest and nonce), (b) the capability from `AUTHORIZATION_MATRIX` in
   `@dockside/core`, and (c) the trade relation recomputed from the bound terms on every request
   (`relationsOf`: bound buyer, supplier, inspector, risk resolver, or membership of the buyer or supplier
   organisation). Role-specific mutations additionally require the exact bound principal **and** key
   version (`requireBound`), checked before any intent, hold or operation state is read. The services and
   then the contract re-check everything again. No request field, header, cached projection or UI flag
   is read as authority; every body schema is strict, so `force`/`releaseReady`-style fields fail as
   `UNKNOWN_FIELD`.
2. **No enumeration.** A principal with no relation to a trade gets `NOT_FOUND "trade not found"` — byte
   for byte the same answer as for an id that does not exist. Holds, release intents and operations
   resolve to their trade first and answer `hold/release intent/operation not found` the same way.
   Capability failures are checked before the lookup, so they are independent of the id.
3. **Route shape.** One `:id` segment per path (`/v1/trades/:id/...`, `/v1/holds/:id/...`,
   `/v1/release-intents/:id/...`, `/v1/operations/:id/...`). Prepare routes return the canonical payload
   as typed JSON (`purpose`, `payload`, `digest`); the client recomputes the digest and signs with its own
   key; record routes verify and return the exact relay call (`{ relay: FunctionCall }`). The API never
   holds a party key and never submits a party action itself. The web catalog
   (`apps/web/src/lib/api/endpoints.ts`) lists every served route; its test checks it against the router.
4. **Holds.** The bound risk/policy resolver may prepare and record a hold SET (`issuerRole` must be
   `RISK_RESOLVER`) and a RESOLVE. Deterministic-policy SETs run only in the policy service's isolated
   signer process (`HoldService.setByPolicy`); no session can submit a `POLICY_SETTER` payload. The
   buyer may file a review request (`authorizing: false`) and view it. Nobody else reaches these routes.
5. **Release execution is queued, never relayed.** `POST /v1/release-intents/:id/execute` is limited to
   the bound buyer approver and calls `JournalService.enqueueRelease`, which re-checks the full release
   conjunction (current attestation, current PASS, no ACTIVE or EXPIRED_UNRESOLVED hold, approval, lock)
   and writes operation plus outbox atomically. The M05 outbox worker submits it; the contract re-checks
   it again. A duplicate joins the same operation.
6. **Operator requests only ask.** Reconciliation, adjudication, source hints and freeze require the
   trade's bound risk resolver and write `operator_requests` rows. `FORCE_TERMINAL_STATUS` and
   `RELEASE_VALUE_LOCK` stay `[]`; no route can set PAID, REFUNDED or FAILED.
7. **Idempotency-Key.** Optional on authenticated POSTs. The key is scoped to principal and exact path,
   bound to the SHA-256 of the exact body, and **reserved before the handler runs** (a `PENDING` row),
   so concurrent duplicates cannot both execute (`VERSION_CONFLICT` while in flight). An exact repeat
   replays the stored response with `Idempotent-Replay: true`; a different body is
   `IDEMPOTENCY_CONFLICT`. A failed request deletes its reservation and stores nothing, so a replay
   re-runs every check and a denial can never become a stored success.
8. **Audit export (`GET /v1/trades/:id/audit-export`).** Built from the append-only tables of M01-M05
   (revisions and successors, principals/key versions/role grants/service enrollments of every bound
   authority, policy, manifests, items, attestations, inspections, holds, resolutions, review requests,
   release intents/events/children/signatures, operations/transitions/observations/dispositions/outbox,
   incidents, freezes, operator requests, audit events with their hash links) plus one fresh observation
   of the escrow views (trade, ledger with per-funder buckets, refunds, holds, evidence, release). It
   lists its exclusions and carries `checksum = SHA-256(stable JSON of every other field)` with sorted
   keys, bigint as decimal and bytes as hex; `verifyAuditExport` recomputes it after transport. It also
   reports the global audit hash-chain verification and head hash.
9. **Redaction by construction.** Exports and projections never contain evidence bytes or text
   extracts, session tokens, invitation secrets, challenge state, private keys, custody locators, display
   names, review-request notes or signed transaction bytes (digests only). Default exports also replace
   buyer, supplier, funder and destination account ids with `acct_<sha256 prefix>`;
   `?destinations=full` is limited to the trade's parties and their organisations' security admins
   (SECURITY.md data policy). Request logs carry method, path without query, status and duration only.
10. **Configuration.** The API wires the trade modules only when `DOCKSIDE_ESCROW_CONTRACT_ID` and
    `DOCKSIDE_NEAR_RPC_URL` (new, https or loopback) are set; `DOCKSIDE_OBJECT_STORE_DIR` (new) holds
    evidence objects. Without them, trade routes answer `NOT_FOUND "no such endpoint"` with
    `reason: TRADE_MODULES_NOT_CONFIGURED`, which the web shell already renders as unavailable.
11. **Worker.** `services/worker` (`@dockside/worker`) ships `WorkerLoop` (non-overlapping delivery plus
    reconciliation ticks over the M05 engines). Its entry point refuses to start (`exit 78`,
    `RELAYER_SIGNER_NOT_PROVISIONED`) because no relayer `TxSigner` with real custody exists in this
    build.
12. **M06 is interfaces only.** `@dockside/payout` defines the dry-compatibility states
    `NOT_RUN | UNKNOWN | INCOMPATIBLE | PASS`, a pure classifier, the `OneClickAdapter` interface, a
    `BlockedOneClickAdapter` that always answers NOT_RUN, the FundedPayoutAuthorization field list, and a
    gate that always fails `FUNDED_RAIL_BLOCKED`. Nothing reads these states for escrow decisions.

## Consequences

- Trade creation over HTTP (`POST /v1/trades`) takes terms plus both parties' signatures collected by the
  clients; the dual-signature exchange itself is a client flow (M08).
- ManifestAttestor enroll/prove/activate/rotate/recover/revoke/status are the M01 service-enrollment
  routes; `GET /v1/trades/:id/attestor` reports the bound attestor and its binding issues. Attestation
  signing stays in the attestor's isolated process.
- Read routes call `ReleaseService.readiness`/`sync`, which mirror contract state into the release
  journal as observations; they never change economic state.
- The approval binds the holds-view digest, so after any hold SET/RESOLVE the old approval is stale; the
  parties CANCEL and start a fresh intent. This is the contract's rule and the API preserves it.
