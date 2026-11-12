# ADR-0012 — Key-management screens and the new-trade-revision consequence

- Decision status: accepted (M12 follow-up)
- Date: 2026-11-12, Dockside platform team (M12)
- Affected IDs: UI-SPEC §3.10 and §9, SECURITY.md (key rotation, revocation, recovery, service custody), INV-13,
  T-037, T-039, T-040
- Relates to: ADR-0003 (sessions and service custody), ADR-0005 (attestation and binding status), ADR-0008 (web
  shell), ADR-0010 (product UI and local stack)

## Context

M01 serves every key route (human rotation, revocation, delayed recovery with veto, service enrollment, proof,
activation, rotation, recovery and revocation), and M03/M07 already refuse a trade action whose revision binds a
key that is no longer the current usable version (`bindingStatus`, `KEY_NOT_BOUND`, invalidated attestations).
The web app had no screen for any of it, so the T-037 states "wrong scope, wrong attestor, wrong key version" could
not be driven in a browser, and an administrator could not see what a key change does to in-flight trades.
UI-SPEC §3.10 requires that rotation or recovery never silently affects an active trade and that the UI requires a
new trade revision and renewed evidence, inspection and release authority.

## Decisions

1. **Read models, not new authority.** Three authenticated reads were added: `GET /v1/organization/directory`
   (security administrator or auditor: human principals with capabilities and every key version, service
   enrollments with custody kind, recoveries, the server's recovery delay), `GET /v1/me/keys` (the caller's own key
   history and any recovery targeting it) and `GET /v1/organization/trade-bindings` (every trade revision that
   binds a principal or service of the caller's organization, per role, with the M01 binding issues). The trade
   projection carries `authority` (the same `bindingStatus`), the trade list `requiresNewRevision`, and the attestor
   view `organizationAttestors` (only the viewer organization's ManifestAttestor enrollments, with
   `boundByRevision` and scope `coverage`). Every mutation is an unchanged M01 route. Custody locators and key
   material are never served.
2. **Human rotation stays in the person's browser.** The new key is generated non-extractable, the rotation
   challenge is verified by the browser (digest, origin, purpose, key, principal) and signed only on an explicit
   action. The server ends the old session; the UI stores the new key, removes the superseded key record and asks
   the person to sign in again. It never signs the login automatically.
3. **Recovery hand-over.** The principal generates the recovery key on its own new device under `/recovery`
   (works signed out) and gives the public key to an administrator. Starting the recovery returns the server's
   `RECOVERY_KEY` challenge; the administrator hands over a secret-free package (`dockside/recovery-package@1`:
   recovery id, principal, not-before and the challenge). The principal pastes it, the browser checks that the
   package and challenge agree and name a key stored there, and the principal signs the proof. A principal that
   still holds its existing key vetoes from the same screen (`RECOVERY_CANCEL`). Completion is a separate
   administrator action; the client does not pre-judge the delay with its own clock, so an early attempt reaches the
   server and its `DELAY_NOT_ELAPSED` refusal is shown.
4. **Service keys never touch the browser.** The custody operator creates the key and returns its public key and an
   opaque locator. The browser verifies the service PoP challenge (digest, origin, the purpose the administrator
   asked for, enrollment, version, key) and shows it for the custody operator, who signs inside custody and returns
   only the signature. The locator field is write-only (masked input, cleared after submit, never served back). In
   the local stack a control-port custody stand-in spawns one isolated signer process per key, allowed to sign only
   its PoP challenge and the single purpose of its capability (`MANIFEST_ATTESTATION` or `HOLD_SET`); the stack's
   attestor and policy loops sign with whichever custody key a revision binds.
5. **Effects on in-flight trades are shown before and after.** Every confirmation for revocation, recovery start
   and completion, service rotation, recovery, activation and revocation lists the trade revisions that bind the
   affected key (from the trade-bindings read). After the change every tab of the trade workspace shows "A new trade
   revision is required" with the role and binding issue; the evidence tab shows the binding issues and the
   organization's attestors as bound or not (wrong attestor), covering or not (wrong scope) and bound version versus
   active version (wrong key version); the trades list flags the trade.
6. **The rebinding revision itself is not built.** No API route creates a trade revision that rebinds rotated,
   revoked or recovered keys (the destination change is the only revision flow the backend serves). The UI states
   the requirement and offers no control rather than inventing one. Follow-up: a dual-signed key-rebinding revision
   in the evidence/authority services and the contract, followed by renewed evidence, inspection and release.
7. **Recovery delay is configurable in the local stack** (`DOCKSIDE_RECOVERY_DELAY_MS`, default the API's two days;
   the browser tests use 20 s so they can watch the delay hold and then elapse).
8. **Confirmation dialogs get unique title ids** (`useId`), because key screens render one dialog per key row.

## Consequences

- T-037's wrong-scope, wrong-attestor and wrong-key-version states are now driven end to end in the browser, by a
  browser-bootstrapped organization whose administrator enrolls, binds and rotates its own services.
- A recovery challenge that expires before the principal proves it cannot be re-issued, and the stuck recovery
  blocks a new one ("a recovery is already in progress") unless the principal vetoes with its existing key. This is
  an M01 limitation, recorded as a follow-up; the package shows the challenge expiry.
- Policy, retention, RPC/provider endpoint and refund-authority settings named in UI-SPEC §3.10 remain unbuilt.
- Nothing here runs on NEAR testnet, and one operator still drives every key in tests (INV-13 acceptance NOT_RUN).
