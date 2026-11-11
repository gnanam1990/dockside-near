# ADR-0010 — Product UI on the real trade API, server-prepared payloads, local stack for browser tests

- Decision status: accepted (M08)
- Date: 2026-11-12, Dockside web team (M08)
- Affected IDs: M08, UI-SPEC §3–§9, FR-01, FR-03–FR-06, FR-08–FR-15, NFR-03, NFR-04, NFR-06, INV-03–INV-05,
  INV-07–INV-13, T-036, T-037, T-038, T-039, T-040, T-054; T-034 client boundary
- Relates to: ADR-0003 (PoP sessions), ADR-0006 (release, exits), ADR-0007 (journal), ADR-0008 (web shell),
  ADR-0009 (integrated API)

## Context

ADR-0008 shipped the web shell before the trade routes existed. M07 (ADR-0009) now serves every trade route,
but three things were still missing for a browser to run the product path: (1) a way for a buyer to produce
revision-1 terms that bind the counterparties' *current* key versions and the organisation's enrolled services
without reimplementing the canonical trade schema in the browser, (2) an inspection payload builder for the
bound inspector, and (3) something that runs the API with its trade modules, the outbox worker, the attestor and
policy services and a chain the browser tests can reach, on a Windows machine with no Docker, testnet accounts or
relayer key.

## Decisions

1. **The browser signs, the server prepares.** Every signed payload comes from a server prepare route; the
   browser recomputes the DCE-1 digest itself (`apps/web/src/lib/signing.ts`) for the purpose the route names,
   refuses on any mismatch or encoding error, shows the exact fields, actor, expiry and consequence, and signs
   only on an explicit action. The only payload the browser builds itself is the evidence issuance statement
   (seven flat fields over the SHA-256 of the file it already holds); a unit test checks it against
   `issuancePayload` byte for byte. New prepare routes (services/api/src/trades.ts):
   - `POST /v1/trade-proposals` (bound buyer approver): resolves the named supplier signer, inspector and
     risk/policy resolver to their current ACTIVE key versions and the buyer organisation's single ACTIVE
     MANIFEST_ATTEST and DETERMINISTIC_POLICY_SET enrollments covering the policy (or the named ones), and returns
     terms JSON + typed canonical payload + digest + binding issues. **Nothing is stored.** Every unusable
     principal gets the same message, so the route does not reveal which check failed.
   - `POST /v1/trade-proposals/review` (a party the terms name): re-derives the payload and reports whether the
     proposer's signature verifies against the bound buyer key.
   - `GET /v1/trades/:id/evidence-policy`: the registered policy JSON the slot checklist renders.
   - `POST /v1/trades/:id/inspection-challenges` (bound inspector and key version): the inspection payload over
     the current attestation.
   - `POST /v1/trades` additionally returns `policyRelay`, the `register_evidence_policy` call the contract needs
     after `register_trade`.
2. **Out-of-band packages for dual-party payloads.** The API stores no proposal and no CANCEL payload (the
   contract keeps only the cancel digest). The proposer copies a package (terms + own signature, or the cancel
   payload) to the counterparty, whose session re-derives and checks it: proposals through the review route,
   cancellations by recomputing the digest and comparing it with the contract's `pendingCancel.digest`.
3. **Relaying is a separate, optional service.** Record routes return `{relay: FunctionCall}`. The UI shows the
   exact call; when `/relay/v1/status` answers (the web server proxies `/relay` only when `DOCKSIDE_RELAYER_URL`
   is set) it offers "Submit to the escrow contract", otherwise it shows BLOCKED with the call for the user's own
   wallet. No relayer exists outside the local stack today (ADR-0009: no relayer key custody).
4. **Controls follow backend rules, never replace them.** Controls are shown by trade relation (from the
   projection's `viewer.relations`) and by the state the backend reports: resolution signing only for the bound
   risk/policy resolver, a non-authorizing request form for the buyer, exits only for the two parties and only
   before submission, reconciliation/adjudication requests only for the risk resolver and only in REVIEW or
   ADJUDICATION (the journal refuses them otherwise; in UNKNOWN the page says the reconciler runs on its own
   schedule). No dry-compatibility state is shown as a value because the API reports none.
5. **In-flight actions stay mounted.** Recording a signature changes the state that decides whether its control
   is shown (for example a hold reads RESOLVED as soon as the resolution is recorded, before the contract call is
   submitted). The workspace keeps a pinned set so a started flow keeps its relay step and outcome on screen.
6. **Local stack for browser tests (`scripts/local-stack/stack.ts`, `pnpm run stack`).** One Node process runs
   `createApp` with the trade modules wired exactly as `services/api/src/main.ts` wires them, a fresh SQLite file,
   the M05 outbox worker and reconciler (`WorkerLoop`), the ManifestAttestor and deterministic-policy services in
   isolated signer child processes (attesting complete manifests and evaluating the versioned rules on evidence
   changes), and three organisation administrators acting through the authority service. The chain is the M02
   simulated host running the compiled escrow wasm behind the M05 JSON-RPC server, reached only through the
   production `JsonRpcNearClient`/`NearTxClient`. It is run by Node's own TypeScript support with a resolve hook
   that maps `@dockside/*` to the built packages and lets it load the simulator from the test tree. Human trade
   roles are never created there: the control port only issues the administrator's invitation and later grant;
   each person accepts in a separate browser context with a non-extractable WebCrypto key. The control port also
   deposits as a funder wallet and toggles chain faults (status source down, lost broadcast response, withheld
   receipts). It is a loopback developer tool and must never be exposed.

## Consequences

- The browser suite now exercises bootstrap/invitation, proposal and countersignature, registration, funding,
  evidence uploads with real refusals and a cross-session compare-and-swap conflict, attestation, inspection,
  deterministic-policy SET, buyer request, risk RESOLVE, expired-unresolved blocking, intent lock, approval,
  queued execution, UNKNOWN → REVIEW → reconciliation request → PAID, export — on a simulated chain. None of this
  is a testnet result; T-036's "direct native testnet NEAR release" stays NOT_RUN until a deployment exists.
- Destination-change, refund-request and organisation key rotation/recovery/service screens are not wired: the
  first two have no API routes yet, the third is M01 surface left for a follow-up. The UI says so instead of
  offering controls.

## Flip conditions

- If the API gains a proposal or cancellation mailbox, drop the copy/paste packages.
- If a relayer with real custody is provisioned, point `DOCKSIDE_RELAYER_URL` at it; the UI is unchanged.
- If Node's TypeScript transform support changes, compile the stack with `tsc` instead of loading it directly.
