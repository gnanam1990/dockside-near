# ADR-0015 — Status consolidation after M10–M12, Linux reproduction and the deployable wasm

- Decision status: accepted (M13 consolidation)
- Date: 2026-11-12, Dockside platform team (M13)
- Affected IDs: REAL-PRODUCT-GATE items 1, 4, 8, 9, 10, 11; T-036, T-038, T-042, T-043, T-045
- Relates to: ADR-0004 decision 13 (local verification strategy), ADR-0011 (reproduction and delivery),
  ADR-0012, ADR-0013, ADR-0014

## Context

M10 (destination change and refunds), M11 (unexpected-asset recovery) and M12 (key-management screens) merged
into main without touching BUILD-STATUS.md, README.md or docs/USER-NEXT-STEPS.md. Those three files still described
the M09 state: no destination, refund, recovery or key screens, a 709 051-byte wasm, and a host without Docker or
WSL. The build host now also has Docker Engine 29.1 inside the WSL 2 distribution Ubuntu-24.04, so a second,
Linux, reproduction is possible without installing anything on Windows.

The first Linux run surfaced two facts that change what the documents may claim:

- The browser test "T-036 buyer locks and approves; T-038 a lost outcome stays locked …; then PAID" failed on
  Linux (twice in a row, deterministic there). The UI showed "Request refused: operation is PAID; reconciliation
  runs on its own schedule." The product was right: the M05 reconciler re-checks a REVIEW operation every 2 s in the
  local stack and leaves REVIEW on its own when new evidence arrives (`engine.ts`, "fresh" observations). The test
  turned the receipts back on and only then clicked "Request reconciliation", so on a faster host the reconciler
  reached PAID first. On Windows the click usually won.
- The contract wasm built on Windows (769 847 bytes, SHA-256 `c4dd8115…`) differs from the one built in the Linux
  container (769 515 bytes, `65b3a00d…`) for the same commit. Among other differences, the Windows wasm embeds 26
  panic-location strings with the builder's cargo home (`<home>\.cargo\registry\src\index.crates.io-…\near-sdk-5.30.1\…`), which carries the
  operating-system user name. Two Linux container builds of the same commit at different checkout paths gave the
  identical digest (`/opt/other-build-dir/x/dockside` and the clean-checkout temporary directory).

## Decisions

1. **Claim stays `IMPLEMENTED_UNVERIFIED`.** Nothing in M10–M13 ran on NEAR testnet or with separate people on
   separate devices. The gate matrix is updated item by item from the M10–M12 status files and this stage's
   re-run; only the local column changes.
2. **Fix the test, not the product.** The reconciliation request is now sent while the receipts are still
   withheld, when the operation is provably REVIEW; the test asserts the request is accepted
   (`Reconciliation requested; operation is REVIEW.`), that nothing looks paid, and then that PAID comes from the
   reconciler once the receipts are readable. The test no longer depends on which side of a 2 s timer a click lands.
3. **The deployable wasm is the Linux container build.** `scripts/container-reproduce.sh` runs
   `scripts/clean-checkout.mjs` in `node:22-bookworm-slim` with Rust 1.97.1 (minimal profile, wasm32 target),
   pnpm 10.34.9 and `CARGO_HOME=/root/.cargo`. Its wasm digest and NEAR code hash are the ones a testnet deployment
   must report. A wasm built on a developer machine is for local tests only: it differs per machine and leaks the
   builder's home path into a public contract.
4. **No build-flag change in this stage.** Remapping the cargo home (`--remap-path-prefix`) would remove the user
   name but not make Windows and Linux builds byte-identical (Windows keeps `\` separators inside each crate path).
   The container build already gives a host-independent artifact. Flip condition: if the deploy must be built
   outside a container, add path remapping and record the new digest.
5. **near-workspaces / near-sandbox and near-sdk `unit-testing` move from BLOCKED to NOT_RUN.** The platform
   blocker (no Windows sandbox binary, no C toolchain on windows-gnu) is gone inside the Linux container, but no
   near-workspaces tests exist yet. They are follow-up work, not evidence.
6. **The second host's results are recorded next to the first.** Both reproductions run the same script steps
   (frozen install, `pnpm run check`, `pnpm run contract:test`, `pnpm audit --prod`, build manifest, browser
   suite). The TypeScript dist digest is identical on both hosts; only the wasm digest differs, as explained above.

## Consequences

- BUILD-STATUS.md, README.md and docs/USER-NEXT-STEPS.md now describe M10–M12 and point to `docs/status/M13.md`
  for the exact build. USER-NEXT-STEPS §1 tells the user to build the deployable wasm with the container script.
- The M09 build manifest (`docs/evidence/M09/build-manifest.json`) stays as M09's record; the current build's
  manifests are in `docs/evidence/M13/`.
- Follow-up work that is still open is listed in BUILD-STATUS "Blocked or not run": the rebinding trade revision,
  re-issuing an expired recovery challenge, policy/retention/integration settings, NFT and multi-token recovery
  adapters, recovery of assets not tied to a trade, process kills for the asset engine, near-workspaces tests.
