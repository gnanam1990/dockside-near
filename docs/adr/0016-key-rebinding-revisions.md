# ADR-0016 — Key-rebinding revisions, recovery challenge re-issue and simulated trade time

- Decision status: accepted (M14 follow-up)
- Date: 2026-11-12, Dockside platform team (M14)
- Supersedes: [ADR-0012](0012-key-management-screens.md) decision 6 ("the rebinding revision itself is not
  built"). ADR-0012 decisions 1–5, 7 and 8 stand.
- Affected IDs: TDD §4 (ManifestAttestor rotation, revocation, recovery), SECURITY.md (rotation without silent
  substitution), UI-SPEC §3.10, T-006, T-037, T-039, T-040; REAL-PRODUCT-GATE items 3, 4 and 11
- Relates to: ADR-0003 (sessions and custody), ADR-0006 (destination supersession), ADR-0007 (journal),
  ADR-0010 (local stack), ADR-0013 (destination screen)

## Context

TDD §4: rotation creates a new key version but never changes an active revision; using it "requires a new
dual-signed trade revision, fresh manifest attestation, inspection, release intent, and approval"; recovery
"never silently replaces a supplier, inspector, destination, or approver inside an active trade; that requires an
explicit revision and renewed authority". Until M14 the only successor revision the contract accepted was a
destination change, so a trade whose bound key was rotated, revoked or recovered was stuck: every tab said a new
revision was required and offered nothing. ADR-0012 also left two follow-ups: an expired key-recovery challenge
could not be re-issued, and T-037's STALE slot was never driven in the browser.

## Decisions

1. **A key rebinding is its own successor protocol.** `contract/.../rebinding.rs` accepts a successor revision
   that differs from the active one only in the bound key version and public key of existing roles (buyer,
   supplier, inspector, risk/policy resolver, ManifestAttestor, deterministic-policy setter). Principals,
   organizations, enrollments, service ids, scopes, capabilities, accounts, amount, destination, delay policy and
   expiry must be byte-identical (`IMMUTABLE_FIELD`). A changed role needs a new public key and a new version id
   (a service key a strictly newer version). The same rule is mirrored in `@dockside/core`
   `keyRebindingRoles`, which the evidence service uses before binding the successor.
2. **The unchanged party anchors the rebinding.** The contract cannot read the organization directory, so it only
   trusts a new key through a key it already binds: one rebinding changes **at most one** of the buyer and
   supplier keys (`SEPARATION_OF_DUTIES` otherwise). The party whose key changes signs with its **new** key (it
   accepts the new revision with the key it now holds); the other party signs with the key the active revision
   binds, which must not be revoked on chain (`KEY_REVOKED`). Both party keys rotated means two rebinding
   revisions; the authority plan rebinds the buyer first and lists the supplier as deferred. The old key of a
   rebound party cannot sign for it.
3. **Delay only when a party key changes.** After the second consent the trade's signed
   `delayPolicy.destinationChangeDelayMs` must pass before activation when the buyer's or supplier's own key
   changes, giving either party time to revoke (`dockside/key-rebinding-revoke`, a new signing domain). A
   rebinding of non-party roles only is activatable at the second consent. No new term was added to the signed
   trade schema.
4. **Activation renews authority exactly like a destination change** (TDD §7 step 8): the terms and digest are
   replaced, so every payload signed for the old revision fails `STALE_REVISION`; the accepted manifest and
   inspection move to history; unresolved holds keep blocking; a pre-submit intent becomes
   `SUPERSEDED_PRE_SUBMIT` and its exact reservation moves to one successor; activation is refused while a release
   is submitted or unresolved, after release, while a refund is live, and after the anchoring party key was
   revoked. The on-chain revocation mark of every rebound role is cleared; other roles keep theirs. A rebound
   inspector also invalidates items it issued under its old key (the contract verifies issuer signatures against
   the bound key), so the inspector re-issues them.
5. **One pending successor revision at a time.** A destination change and a key rebinding exclude each other
   while either awaits consent or activation (`DESTINATION_CHANGE_PENDING`, new `KEY_REBINDING_PENDING`), at the
   API and in the contract. A never-countersigned proposal past its seven-day consent window does not block.
6. **What gets rebound comes from the authority, not the caller.** `AuthorityService.rebindingPlan(terms)` lists,
   per role, the bound key, its binding issues and the principal's or enrollment's **ACTIVE** key, or why there is
   none: `NO_ACTIVE_KEY` (for example a recovery still waiting for proof or for its delay), `CAPABILITY_MISSING`,
   `SCOPE_MISMATCH`, `ENROLLMENT_REVOKED`. The last three need a different participant or service, which is a
   different kind of revision and is not built. The API builds the successor from the plan; the second party signs
   the successor the first consent journaled, so a plan that changes in between cannot swap the digest.
7. **Routes and authority.** `GET /v1/trades/:id/key-rebinding` (any trade relation) and six POST routes
   (challenge, consent, revocation challenge, revocation, activation, binding). Every POST needs the
   `ACCEPT_TRADE_REVISION` capability, a relation to the trade (otherwise the same `NOT_FOUND` as for a trade that
   does not exist) and the trade's bound buyer approver or supplier signer principal (a capability holder that is
   not the bound party is refused and audited as `KEY_REBINDING_DENIED`), then the session key that this successor
   binds for that party (refusals audited as `RELEASE_ACTION_DENIED`). Consents and revocations are verified, journaled in `release_signatures`
   (migration 0008 rebuilds that append-only table to admit the two new kinds) and audited
   (`KEY_REBINDING_CONSENT_RECORDED`, `KEY_REBINDING_REVOCATION_RECORDED`, `KEY_REBINDING_ACTIVATION_PREPARED`,
   `KEY_REBINDING_REVISION_BOUND`). Activation and binding are relays the contract re-checks; binding reuses the
   journaled-successor path of the destination protocol and requires the contract digest to match.
8. **The control replaces the notice.** The "A new trade revision is required" callout on every tab now links to
   the key-rebinding section of the Agreement tab, which shows the plan (bound and current key per role, deferred
   and blocked roles), the pending revision with both consents and the delay, what activation invalidates, the
   signed actions (start or consent, cancel), activation with confirmation and the history. The browser refuses to
   sign when the session key is not the one the successor binds for this party; the server enforces it anyway.
9. **Re-issuing an expired recovery challenge.** `POST /v1/recoveries/:id/challenges`: a security administrator of
   the organization other than the principal re-issues the `RECOVERY_KEY` challenge of a recovery still in
   `PENDING_PROOF`, only once the current challenge has expired. The new challenge binds the same new key and
   version; `notBefore` is unchanged (the delay keeps running from the request and the veto stays open); the
   expired challenge stays unusable; the event is audited (`RECOVERY_CHALLENGE_REISSUED`). Recovery challenges get
   their own lifetime setting, `DOCKSIDE_RECOVERY_CHALLENGE_TTL_MS` (10 s to 24 h, default the general challenge
   lifetime), because the package is handed over out of band. The directory serves `challengeExpiresAt`; the keys
   screen offers the re-issue and the recovery screen tells the principal to ask for one.
10. **Simulated trade time for the STALE slot.** The local stack gained `POST /control/clock`, which moves the
    simulated trade clock (evidence, holds, release, journal, worker and the API routes) and the simulated chain
    clock forward together. The authority, sessions and request proofs keep the wall clock, because the browser
    signs with it. The stale-evidence browser test runs on its own stack (`playwright.clock.config.ts`). Nothing in
    a production build reads this clock; `services/api/src/main.ts` is unchanged.

## Consequences

- T-006's "explicit dual-signed trade revision plus downstream reauthority" is driven at the contract, the API and
  in the browser on the simulated chain, including renewed evidence, attestation, inspection and an approval signed
  by the rebound key, paid through the worker. Separate people on separate devices and NEAR testnet stay NOT_RUN.
- A trade where both party keys changed needs two rebindings; a role that lost its capability or scope cannot be
  rebound and needs a participant-replacement revision, which is not built.
- T-037's STALE slot is driven in the browser by simulated time, not by editing state. Recovery by replacement
  cannot be completed on that stack: the browser issues a replacement with its wall-clock time, which is already
  older than the simulated freshness deadline, so the server refuses it (`STALE_ITEM`). Replacement after
  staleness is covered at the service level (T-011, T-012, T-018).
- The contract state layout changed (new `rebinding` field); nothing is deployed, so there is no migration of chain
  state. The deployable wasm must be rebuilt in the Linux container (ADR-0015).
- README's configuration table does not list `DOCKSIDE_RECOVERY_CHALLENGE_TTL_MS` yet; that is left to the
  consolidation stage.
