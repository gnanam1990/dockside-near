# ADR-0004 — NEAR escrow contract shape, refunds and local verification

- Decision status: accepted (M02)
- Date and authorship: 2026-11-11, Dockside build stage M02/M03 (coding agent)
- Affected IDs: FR-02, FR-14, NFR-01, NFR-02, INV-02, INV-12, T-007, T-008, T-051; holds for FR-12/FR-13,
  INV-10/INV-11, T-014/T-016; consumed by M03, M04, M05

## Context

CORRIDOR-CONTRACT.md fixes one testnet path (native testnet NEAR, buyer -> escrow contract -> bound supplier
account) and REFUND-POLICY.md `dockside-refund-v1` r1 fixes the refund rows. TDD §5 says the callable
interface must be derived from the actual NEAR SDK. The host is Windows 11 with the `x86_64-pc-windows-gnu`
Rust toolchain, no C compiler, no Docker/WSL.

## Decisions

1. **Core/wrapper split.** All authority logic lives in `contract/crates/dockside-escrow-core` (no NEAR SDK,
   `no_std + alloc`), compiled into the wasm and host-tested with ed25519-dalek. `contract/crates/dockside-escrow`
   (near-sdk 5.30.1) only supplies block time, predecessor, current account, `env::ed25519_verify`, storage
   (`store::LookupMap<tradeId, TradeRecord>`) and the refund transfer promise.
2. **Signed payloads cross the boundary as typed JSON** (`toTypedJson` form). The contract decodes it to a
   DCE-1 value, recomputes the domain digest itself, checks the exact field set (unknown/missing fields fail
   closed, so `complete=true`/`eligible=true` are rejected) and only then reads fields. TypeScript builders
   (`@dockside/near` payloads) are the single service-side definition of each shape.
3. **Registration.** `register_trade` takes the full canonical terms and both party signatures over the
   `dockside/trade-revision` digest. Party signatures are made with the principals' **enrolled Dockside keys**
   (M01), not necessarily their NEAR account keys; the NEAR transaction may be relayed by any account. A wallet
   that can only produce NEP-413 `signMessage` signatures cannot sign these raw digests yet: supporting a
   NEP-413 envelope on-contract is deferred (M08 decides browser key custody). Only revision 1 is registrable
   here; successor revisions arrive with the destination-change protocol (M04).
4. **Funding identity is NEAR-native.** The original funder of a deposit is the predecessor account of the
   `fund` call (the account whose transaction attached the NEAR). Any account may fund; each deposit is recorded
   with its funder. Under-funded value is `PARTIAL` (never releasable), the completing deposit promotes all
   `PARTIAL` to `AVAILABLE`, value beyond the amount is `QUARANTINED` for that funder with its detection time.
   A minimum deposit (default 0.001 NEAR) bounds storage griefing.
5. **Refund rows implemented in M02:** `TRADE_EXPIRY`, `MUTUAL_CANCEL`, `PARTIAL_FUNDING_RETURN`,
   `EXCESS_FUNDING_RETURN`. The key-loss rows return `NO_REFUND_SUBMIT`. `INSPECTION_FAIL` and `PERMANENT_HOLD`
   return `REASON_NOT_ENABLED` until M04 joins inspection, holds and release. The contract computes the eligible
   amount and source bucket from its own ledger and requires the request to restate them exactly
   (`STALE_LEDGER` otherwise). Funder rows are authorized by the predecessor being the funder; party rows by
   Ed25519 signatures of the bound buyer/supplier keys. Value is locked at request time; revocation and
   authoritative `FAILED` restore the recorded bucket (`EXCESS_FUNDING_RETURN` always to `QUARANTINED`).
6. **Clock origins:** expiry = signed `expiresAt` (+24h challenge); mutual cancel = second signature (+1h);
   partial = request time (+1h); excess = detection time of the funder's latest excess (+1h). Authorization and
   execution are permissionless once the deterministic predicates hold.
7. **Funding is frozen while accepted value is being refunded** (`FUNDING_FROZEN`), so a pending partial/expiry/
   cancel refund can never be reclassified by a new deposit. Excess returns do not freeze funding. After a
   refund settles out of `AVAILABLE`, a trade below its amount demotes the remaining `AVAILABLE` to `PARTIAL`.
8. **Holds read by refunds:** `TRADE_EXPIRY` and `MUTUAL_CANCEL` authorization fail with `HOLD_ACTIVE` while any
   hold is `ACTIVE` or `EXPIRED_UNRESOLVED`; partial/excess funding returns are not blocked (they return value
   that never became releasable). Flip condition: a risk review that wants funding returns held too.
9. **FAILED vs UNKNOWN on chain.** A native transfer to a missing account fails and the runtime returns the
   value to the contract; the private callback observes the failed promise and records `FAILED` with the exact
   bucket restored. If the callback never runs (gas exhaustion), the intent stays `EXECUTING` and locked; it is
   reconciled off-chain from the original transaction identity (M05). There is no admin or retry entry point.
10. **Unexpected assets** (`ft_on_transfer`, `nft_on_transfer`, `mt_on_transfer`) are kept and recorded as
    `ASSET_RECOVERY_REVIEW` with the observed token contract, exact amount, *claimed* sender and a digest of the
    untrusted `msg`; no original funder is set and no withdrawal entry point exists. Returning tokens to the
    claimed sender automatically was rejected because the sender is not proven.
11. **Bound-key revocation on chain:** a bound key can revoke itself; buyer or supplier can revoke the inspector,
    risk resolver, ManifestAttestor or policy-setter key, but not each other's. Revocation only removes
    authority, never substitutes a key; a rotated/recovered key needs a new trade revision.
12. **Build:** the wasm is built from inside `contract/` with `--cfg near` (`contract/.cargo/config.toml`); without
    it near-sdk compiles host fallbacks and contract panics lose their message. `scripts/build-contract.mjs`
    refuses an artifact without the `panic_utf8` import and prints its SHA-256.
13. **Local verification strategy.** `near-sdk` `unit-testing` does not build on this host (getrandom/windows-sys
    need `dlltool` import libraries, `aws-lc-sys` needs a C toolchain) and `near-sandbox` has no Windows binary
    (only Linux x86_64 and macOS arm64), so near-workspaces is BLOCKED (evidence in `docs/evidence/M02`).
    Instead: (a) host tests of the core crate; (b) the compiled wasm runs under a **simulated NEAR host**
    (`packages/near/test/sim/near-sim.ts`) that implements the near-sdk host imports, per-call atomicity,
    deposits, transfer receipts with failure refunds and callbacks. It is not nearcore: no gas, storage staking,
    cross-block scheduling or protocol wasm-feature validation. Flip condition: run the same scenarios on
    near-sandbox (Linux/macOS CI) or testnet and record them as the real evidence.

## Consequences

- Release (`DIRECT_TESTNET` transfer to `payout.destination`) is not exposed yet; M04 adds it behind the full
  release conjunction, reading the same ledger, holds and evidence state.
- The 450 KB wasm needs ~4.5 NEAR of storage stake; size reduction (wasm-opt, fewer `json!` views) is optional.
