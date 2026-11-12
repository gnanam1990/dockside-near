# ADR-0022 — Contract storage bounds for permissionless callers

- Decision status: accepted (security fix, dockside m33-contract-storage-bounds)
- Date: 2026-11-12, Dockside platform team
- Affected IDs: T-007, T-008, T-051; FR-02; NFR-02, NFR-04; REAL-PRODUCT-GATE item 9
- Relates to: ADR-0004 (NEAR escrow contract, item 4 "a minimum deposit bounds storage griefing"),
  ADR-0014 (unexpected-asset recovery), ADR-0015 (deployable wasm)

## Context

An external security audit raised three storage-growth leads. Each was reproduced on the real code
before any change (`docs/status/SEC-dockside-m33-contract-storage-bounds.md`):

1. **Receivers.** Any account can call `ft_on_transfer`, `nft_on_transfer` or `mt_on_transfer`
   directly, with no token transfer and no deposit. Each call appended up to 32 records to the
   append-only `unexpected` vector. The escrow account pays the storage stake from the balance that
   also holds every trade's escrowed NEAR, and no method removes a record.
2. **Governing-trade nonces.** `request_asset_recovery` lets the claimed sender of an asset name any
   registered trade as the governing trade. The request, a CLAIMED_SENDER revoke and a CLAIMANT
   challenge are authenticated only by the caller's own account, yet each inserted a nonce into the
   governing `TradeRecord.nonces`. A stranger could create its own NEP-141 record naming itself as
   sender and loop request and revoke without limit: 200 cycles grew a victim trade from 1,957 to
   41,757 bytes. Every later mutation of that trade, including the fixed 15 Tgas settlement callbacks,
   loads and rewrites the whole record.
3. **Deposit history.** `fund` is permissionless and appended one `Deposit` per call. Deposits past
   the trade amount are quarantined and returnable, so a stranger could add minimum deposits until
   expiry: 1,000 deposits grew a trade from 1,957 to 86,130 bytes. The 0.001 NEAR minimum does not
   cover a record's stake once the excess is returned, so ADR-0004's claim did not hold.

The spec does not ask for unbounded growth. SECURITY.md and NFR-02 require fail-closed validation at
every trust boundary, and NFR-04 requires resource budgets. REFUND-POLICY.md keeps an unresolved
unexpected asset in `ASSET_RECOVERY_REVIEW` or `UNRECOVERABLE_OR_REVIEW`.

## Decisions

1. **Contract-wide cap on unexpected-asset records.** `assets::MAX_UNEXPECTED_ASSETS = 16`. Each
   receiver checks `assets::ensure_capacity` for the whole call before persisting anything, so an
   `mt_on_transfer` batch fits whole or not at all. Past the cap the call fails with
   `CAPACITY_EXCEEDED`. For a real `ft_transfer_call`, `nft_transfer_call` or `mt_transfer_call`,
   the token contract then returns the asset to its sender under its own standard. The near-sandbox
   suite shows the NEP-141 case: the sender gets its full balance back and the escrow stores nothing.
   A refusal is the safer outcome for a transfer the escrow cannot record.
2. **Per-asset cap on recovery attempts.** `assets::MAX_RECOVERIES_PER_ASSET = 4`. A fifth request
   fails with `CAPACITY_EXCEEDED`, and the asset stays in its review state, which is the policy's
   outcome for unresolved ownership. Worst-case storage for all records with all attempts, using
   maximal field lengths, is under 100,000 bytes, which is under 1 NEAR of stake. A host test asserts
   that bound.
3. **Unsigned recovery steps never write the governing trade.** The claimed sender's request, a
   CLAIMED_SENDER revoke and a CLAIMANT challenge still require a well-formed nonce that the trade has
   not consumed (`NONCE_REPLAYED`). They no longer insert it. These steps have no signature that could
   be replayed: the transaction's predecessor is the authentication, and each step can run once per
   recovery because of recovery state (unique `recoveryId`, REQUESTED/CHALLENGE_PERIOD to
   REVOKED/CHALLENGED). Steps signed with the trade's bound keys still consume single-use trade
   nonces: risk/policy approval and revocation, and buyer, supplier and risk challenges. An account
   with no role on a trade therefore cannot change that trade's record.
4. **Per-trade cap on the deposit history.** `MAX_DEPOSITS_PER_TRADE = 64`. Past the cap `fund`
   accepts only a deposit that completes an under-funded trade (`amount >= required - committed`),
   for at most `MAX_COMPLETING_DEPOSITS_OVER_LIMIT = 8` more. Filling the history with minimum partial
   deposits before the buyer funds therefore cannot block funding: the buyer's treasury sends the
   remainder in one deposit, and any excess is quarantined as before. Every other deposit past the
   cap fails with `CAPACITY_EXCEEDED`. The worst-case history, with 64 distinct maximal-length
   funders, adds under 32,000 bytes to a trade record (host test). ADR-0004 item 4 is superseded on
   this point: the minimum deposit filters dust, and the cap bounds storage.
5. **No state-layout change.** No borsh type changed. The caps use counts that are already stored
   (`unexpected.len()`, `recoveries.len()`, `deposits.len()`). A deployment that is already over a
   cap keeps its records and only refuses new ones. The new code can therefore be deployed in place
   on an existing escrow account without a migration or a fresh account.

## Consequences

- The deployable wasm changes. Its new SHA-256 and NEAR code hash are in the status file. The testnet
  escrow `gnanam1990-dock-escrow.testnet` runs the previous code hash
  `5wqct3Wxavf9GXpdYJfrGWKpTZb1j95dJZQsNmAvzHuM`. The owner must redeploy it, as a code-only redeploy
  on the same account (decision 5). This change makes no testnet transaction.
- `CAPACITY_EXCEEDED` is a new contract failure code. The API passes it through as `contractCode` on
  `CONTRACT_REJECTED`, like every other contract code.
- The cap on unexpected-asset records is contract-wide and records are never pruned. Once 16 records
  exist, every further unexpected transfer is returned by its token contract. Raising the cap is a
  code change with a storage-reserve decision. The bound in decision 2 is the reserve the escrow
  account needs for these records.
- A CLAIMANT can still end each recovery attempt, as before. With the attempt cap, four such
  challenges leave the asset in review for good, where before it was challengeable without limit.
  Both outcomes are the policy's unresolved-ownership state.
- Out of scope, noted for follow-up: a funder's own request/revoke loop on funder-authorized refund
  rows (`PARTIAL_FUNDING_RETURN`, `EXCESS_FUNDING_RETURN`) still appends refund intents and nonces to
  the trade. The deposit cap bounds how many funders exist, but not how many such cycles each runs.
