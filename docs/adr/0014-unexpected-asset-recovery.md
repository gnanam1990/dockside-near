# ADR-0014 — Unexpected-asset recovery on chain, journaled execution and the asset recovery review panel

- Decision status: accepted (M11 follow-up)
- Date: 2026-11-12, Dockside platform team (M11)
- Affected IDs: REFUND-POLICY `UNEXPECTED_ASSET_RECOVERY` (`dockside-refund-v1` revision 1), FR-14, INV-02,
  INV-12, SECURITY "asset-recovery review", TDD `UnexpectedAssetRecovery` and `unexpected_asset_recoveries`,
  UI-SPEC §3.8 "Asset recovery review", REAL-PRODUCT-GATE items 9, 10 and 11, T-003, T-008, T-051
- Relates to: ADR-0004 (escrow contract, T-051 recording), ADR-0007 (journal), ADR-0010 (local stack),
  ADR-0013 (refund surfaces)

## Context

Since M02 the escrow records NEP-141, NEP-171 and NEP-245 transfers in a separate `ASSET_RECOVERY_REVIEW` list
and never credits them to native-NEAR funding, but it had no way for such an asset to leave: REAL-PRODUCT-GATE
item 9 stayed PARTIAL ("an asset-recovery authorization flow does not exist") and item 11 had no recovery screen.
REFUND-POLICY fixes the row: the claimed sender initiates; claimed-sender proof of control, enrolled risk/policy
approval and an asset-specific contract recovery capability are all required; the clock starts at the final
required authorization and runs 72 hours, "then only when the asset adapter is safe"; buyer, supplier, another
claimant or risk/policy may challenge; the amount is at most the exact observed balance and the recipient only
the independently proven sender; the claimed sender or risk/policy may revoke before execution; after submit the
exact asset is locked, ambiguity is UNKNOWN and reconciliation uses the original transaction without blind retry.
Because the contract holds the asset and the policy says "contract recovery capability", the flow belongs on chain.

## Decisions

1. **The protocol is enforced by the escrow contract** (`dockside-escrow-core/src/assets.rs`, entry points
   `request_asset_recovery`, `approve_asset_recovery`, `challenge_asset_recovery`, `revoke_asset_recovery`,
   `execute_asset_recovery`, private callback `on_asset_recovery_transfer`, view `get_unexpected_asset`). Each
   asset record keeps every recovery attempt; at most one is live. New signing domains:
   `dockside/asset-recovery-request|approval|challenge|revoke` (TypeScript and Rust registries equal).
2. **Proof of control is the claimed sender's own transaction, and the recipient is always that sender.** The
   request must be submitted by the account the token contract reported as sender (`predecessor ==
   claimed_sender`), restate the record exactly (index, standard, asset contract, token id, amount, sender) and
   name the same account as recipient (`RECIPIENT_NOT_SENDER` otherwise). No field can name a buyer, supplier,
   funder or administrator. Exact amounts only (`AMOUNT_MISMATCH`); the record is the observed balance.
3. **A governing trade supplies the authority, never value.** The request binds one registered trade revision
   (header and nonce set). Its bound risk/policy key approves, its bound buyer and supplier keys may challenge,
   and its nonce set prevents replay; the contract rechecks that the trade's native ledger is unchanged and
   conserved after every step. A recovery is invisible in detail to other trades. An asset unrelated to any trade
   cannot be recovered in this build and stays in review (documented limitation).
4. **Approval signs a read-only validation.** Before approval the API reads the token contract
   (`ft_balance_of(escrow)`, `storage_balance_of(recipient)`, `ft_metadata`; `Nep141Reader`), compares the escrow
   balance with the outstanding observed total for that token, and journals the report with a SAFE or UNSAFE
   verdict. Only a SAFE report younger than one hour can back an approval, and its digest
   (`dockside/asset-recovery-validation`) is a field the risk key signs and the contract stores. UNSAFE answers
   `ADAPTER_UNSAFE` and nothing is signable.
5. **The 72-hour challenge window starts at approval** (the final required authorization). Challenges come from
   the bound buyer, supplier or risk/policy key, or from another claimant's own account (unsigned; it cannot be
   the recipient). A challenge or revocation ends that recovery (`CHALLENGED`, `REVOKED`) and returns the asset to
   `ASSET_RECOVERY_REVIEW`; the only way forward is a new request with a new approval and a new window. This keeps
   unresolved ownership in review rather than letting any party decide it.
6. **One safe adapter: NEP-141 `ft_transfer`.** Execution is permissionless after the window, needs exactly one
   yoctoNEAR attached by the executor (never escrow value; returned to the executor if the transfer fails), and
   moves the exact observed amount to the proven sender. NEP-171 and NEP-245 have no adapter in this build: their
   records are `UNRECOVERABLE_OR_REVIEW` and requests answer `ADAPTER_UNSAFE`. A failed `ft_transfer` is reverted
   by the token contract, which the callback treats as the authoritative no-transfer: `FAILED`, asset back in
   review, and that recovery can never execute again.
7. **No unilateral withdrawal still exists.** The record keeps `withdrawable: false` and `originalFunder: null`.
   The M02 wasm test now asserts that no `withdraw`/`sweep` export exists and that the only `recover` exports are
   the six protocol entry points above.
8. **Execution is journaled separately from the M05 economic-operation journal**
   (`packages/journal/src/assets.ts`, migration `0007_asset_recoveries.sql`). The M05 journal is built around
   native-NEAR ledger snapshots and bucket moves, which unexpected assets must never enter. The asset journal reuses
   the M05 fenced leases and the same rules: the signed transaction, its hash and the pre-submit token balance are
   persisted with QUEUED -> SUBMITTING before broadcast; a crash before broadcast resends the identical persisted
   bytes (same hash and nonce) only inside the validity window; a lost response is UNKNOWN and is reconciled from
   the original hash; RECOVERED requires the contract's RECOVERED record and an escrow token balance that dropped
   by at least the exact amount, otherwise REVIEW (no transition out of REVIEW exists); a contract refusal or an
   expired, never-included transaction is NOT_SUBMITTED and a new execution request gets a new operation. The
   state machine and write-once transaction identity are database triggers. The worker loop runs this engine in
   the same tick as M05.
9. **API surface** (`services/api/src/assets.ts`): nine routes under `/v1/trades/:id` with the refund-route
   authority layers (PoP session, `SIGN_REFUND_REQUEST`, the bound role with its exact key version). Trade members
   may read; only the bound buyer or supplier prepares the sender's request (optionally verifying the sender's
   transfer transaction by hash against the record); only risk/policy validates, approves and revokes by key; any
   bound role may challenge or queue execution. The claimed sender's request and revocation and another claimant's
   challenge are returned as unsigned calls for that account's wallet. Every step appends an
   `ASSET_RECOVERY_*` audit event; prepared payloads, validations and verified signatures are append-only.
10. **The web shows unexpected assets only in the Refund tab's "Asset recovery review" panel**, never in deposits,
    refund candidates or conservation. Displayed state is the contract record, except that an execution whose
    outcome is unproven reads UNKNOWN/SUBMITTING and locked. New vocabularies `assetRecord`, `assetRecovery`,
    `assetOperation` (none positive, none with the paid icon).
11. **The browser test runs on its own stack** (`apps/web/playwright.assets.config.ts`, ports 8795/8796/4393 by
    default). It must move the simulated chain clock 73 hours, and on the shared stack every later signed payload
    would then read as expired. `pnpm run web:e2e` runs both configurations.
12. **Simulation boundaries.** The simulated host and chain server gained external-contract routing and a
    simulated NEP-141 token (`packages/near/test/sim/sim-token.ts`) with balances, storage registration, the
    one-yoctoNEAR rule, `ft_transfer_call` delivery and atomic failure. The local stack adds the token, the token
    sender's and a claimant's simulated wallets (`/control/token-transfer`, `/control/nft-transfer`,
    `/control/sender-call`, `/control/token`, `/control/token-faults`). None of this is a real token or account.

## Consequences

- REAL-PRODUCT-GATE item 9's unexpected-asset half and item 11's recovery screen pass on the simulated chain;
  both remain NOT_RUN on testnet. Real tokens differ in storage costs, gas and events, which the simulation does
  not model.
- The escrow storage layout of `UnexpectedAsset` changed (new `recoveries` field). Nothing is deployed, so no
  migration is needed; a deployed contract would need one.
- The wasm grew from 709 051 to 769 847 bytes; the build manifest recorded in M09 no longer matches this build and
  must be regenerated by whoever freezes the next deployable build.
- Recovery of assets not attributable to any trade, NFT and multi-token adapters, and a wallet connector for the
  sender's own transactions are not built.
