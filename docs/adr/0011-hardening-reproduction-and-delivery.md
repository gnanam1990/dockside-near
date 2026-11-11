# ADR-0011 — Hardening, reproduction and delivery evidence

- Decision status: accepted (M09)
- Date: 2026-11-12, Dockside platform team (M09)
- Affected IDs: M09, SECURITY.md (rate limits), REAL-PRODUCT-GATE items 1–13, FR-05, FR-06, NFR-01, NFR-02,
  NFR-06, INV-02, INV-03, INV-05, INV-12, T-041, T-042, T-043, T-044, T-045
- Relates to: ADR-0003 (sessions), ADR-0004 (contract), ADR-0006 (destination change), ADR-0007 (journal),
  ADR-0009 (integrated API), ADR-0010 (local stack)

## Context

M00–M08 built the product and its tests over a simulated NEAR chain. M09 has to audit the result against
REAL-PRODUCT-GATE.md, close the gaps that can be closed on this machine, and deliver truthful status,
reproduction and user documentation. Testnet accounts, deployment, signing, funding and any 1Click call are not
allowed in this build, so the gate's testnet items cannot pass here and the claim level stays
`IMPLEMENTED_UNVERIFIED`.

Open gaps found by the audit: no rate limiting (SECURITY.md lists it; M01 and M07 deferred it), no HTTP route for
the destination change the contract and service already implemented (M08 could not offer the flow), no generated
conservation test (T-041), no installed-artifact or exact-build checks (T-044, T-045), and no clean-checkout run
(T-043).

## Decisions

1. **Fixed-window limits keyed before authentication.** Unauthenticated routes are limited per client address,
   authenticated routes per presented session token (a 128-bit digest of it is the key, the token is not kept).
   The check runs before the body is read or any signature verified. A failed authentication also counts against
   the address, so inventing session tokens does not buy fresh windows. `/healthz` and `/readyz` are exempt for
   orchestration. Defaults are generous (300 unauthenticated and 3000 session requests per minute) because the
   browser suite and local stack run every request from loopback; deployments set
   `DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN` and `DOCKSIDE_RATE_LIMIT_SESSION_PER_MIN` lower. Values below 1 are a
   configuration error (fail closed). The table holds at most 50 000 windows; when full and nothing has expired, a
   new key is refused rather than evicting a live window, which an attacker could otherwise use to reset its own
   count. The limit is per process: several API processes behind a balancer each count separately (a shared store
   is the flip condition).
2. **Socket limits.** `hardenServer` sets header (15 s), request (30 s) and keep-alive (5 s) timeouts, at most
   64 headers and 1000 requests per socket. `main.ts` and the local stack use it.
3. **Destination change over HTTP is a thin layer.** Seven routes under `/v1/trades/:id/destination-*` wrap the M04
   `ReleaseService` methods. The API adds the capability check and the exact bound buyer approver or supplier
   signer (principal and key version) before any state is read; the service re-verifies signatures, the pending
   digest, the journal lock, freezes and the delay; the contract re-checks all of it. Activation stays a
   permissionless contract call, but the API hands its relay only to a bound party. Binding the activated
   revision (`/destination-binding`) is explicit so the evidence and hold services follow the contract's revision
   only after both journaled consents match the contract digest. The web catalog lists the routes; a destination
   screen is still not built (follow-up), so the UI part of T-042 is `NOT_RUN`.
4. **T-041 runs on the contract core with a seeded generator, not a property-testing crate.** A xorshift generator
   (no new dependency) drives the real `dockside-escrow-core` entry points with bound signatures. A refused call
   is rolled back to the prior state, as the NEAR runtime reverts a panicking call. After every step a shadow
   ledger kept by the test and the exact per-bucket moves the step must cause are compared with the contract
   ledger. A third of the steps follow the release path so PAID and returned transfers are reached often. The
   journal-level states (UNKNOWN, REVIEW, ADJUDICATION, late and contradictory receipts) keep their deterministic
   M05 tests; generating them is a follow-up, so T-041 is `PARTIAL`.
5. **Dependencies are optimized in the contract dev profile** (`[profile.dev.package."*"] opt-level = 2`) so host
   tests that sign thousands of payloads finish in seconds. The crates under test keep debug assertions and
   overflow checks; the release (wasm) profile is unchanged, so the contract artifact digest is unaffected.
6. **Exact-build identity is a manifest, not a claim.** `scripts/build-manifest.mjs` records the commit, toolchain,
   lockfile digests, migration checksums, a digest over every built dist file and the wasm SHA-256 plus its NEAR
   code hash (base58 of the SHA-256, what `view_account` reports). `--verify` recomputes everything and refuses a
   manifest whose artifacts differ or whose commit is unknown; commits after the manifest's may change only
   `docs/`, so committing evidence does not orphan it. The deployment section stays `BLOCKED` with null account
   and on-chain hash until a real deployment is verified with `scripts/testnet-deploy/verify-deploy.mjs`.
7. **Clean checkout means a fresh clone of the committed tree.** `scripts/clean-checkout.mjs` clones into a new
   temporary directory (no `node_modules`, `dist` or `contract/target`), installs from the frozen lockfile, runs
   `pnpm run check`, the contract host tests, `pnpm audit --prod`, optionally the browser suite, writes the fresh
   manifest and compares the fresh wasm digest with the working checkout's. Its report names the testnet corridor
   and human acceptance as not run, so T-043 is `PARTIAL` (local reproduction only).
8. **Status consolidation.** BUILD-STATUS.md becomes the gate matrix and test-ID table; per-module detail moves to
   `docs/status/M00.md` … `M09.md` (the M00–M02 sections moved verbatim). `docs/USER-NEXT-STEPS.md` lists the user
   actions that would let the testnet items run.

## Consequences

- No gate item that needs NEAR testnet, real wallets, separate people or a manual assistive-technology review can
  pass in this build; they are `BLOCKED` or `NOT_RUN` with exact steps.
- The limiter can refuse a legitimate client behind a shared NAT address at the unauthenticated limit; operators
  tune the variable or front the API with an address-aware proxy.
- The audit export is still checksummed rather than signed (ADR-0009); a dedicated export key remains open.

## Flip conditions

- A second API process or a load balancer: move limiter windows to a shared store (SQLite table or the proxy).
- A destination screen in apps/web: run the T-042 UI half and record it.
- Testnet accounts and a relayer signer exist: run `docs/USER-NEXT-STEPS.md`, fill the manifest's deployment
  section from `verify-deploy.mjs`, and only then reconsider the claim level.
