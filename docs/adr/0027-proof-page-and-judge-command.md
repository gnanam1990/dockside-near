# ADR-0027 — Proof page on GitHub Pages and the `pnpm judge` command

- Decision status: accepted (M46)
- Date: 2026-11-13, Dockside platform team (M46)
- Affected IDs: REAL-PRODUCT-GATE items 1 and 2 (evidence a reviewer can re-check); NFR-02 (no secrets)
- Relates to: ADR-0020 (CI workflow and its policy), ADR-0019 (run-all and run records), ADR-0026 (design tokens)
- Beyond the spec: `docs/spec/` asks for neither a public proof page nor a judge command. Both are additions for
  reviewers. They change no product behaviour, no contract and no claim level.

## Context

The testnet evidence (M24, M34, M44) is a set of JSON files and status documents. A reviewer has to trust that the
files match the chain, or repeat the RPC queries by hand. We want one page and one command that redo the comparison
live, show the expected value beside the value read, and cannot report success for something they did not read.

## Decisions

1. **One verifier, two front ends.** `site/proof/lib/verify.mjs` (plain ES modules, no dependency, no build) is
   imported unchanged by the page (`site/proof/app.mjs`) and by `scripts/judge/judge.mjs`. Its RPC client
   (`near-rpc.mjs`) allows only `block`, `query` and `EXPERIMENTAL_tx_status`, holds no key and cannot send a
   transaction. All state is read at one final block.
2. **Expected values come only from committed run records.** `scripts/proof/build-manifest.mjs` derives
   `site/proof/proof-manifest.json` from the `run-record.json` files listed in `scripts/proof/sources.json`
   (schema `dockside/testnet-run@1`, written by run-all when the owner ran a journey). It refuses a record whose
   journey did not pass, whose deployed code hash did not match its artifact, or that belongs to another deployment.
   A unit test and the Pages build both fail when the committed manifest differs from the generator's output.
3. **What is checked.** Deployment: the account's code hash equals the manifest; the manifest SHA-256 base58-encodes
   to that hash; the contract bytes downloaded with `view_code` hash to it and have the manifest's size; the
   deployment transaction; the relayer key is a function-call key limited to the escrow. Config: network, minimum
   deposit, refund policy, trade count. Per trade: registration; **ledger conservation recomputed from `get_ledger`**
   with the contract's rules (funder buckets sum to funded, deposits sum to funded, totals are the sum of the
   funders, committed within the trade amount) next to the contract's own flag; funded, released, refunded and
   still-held totals; the release intent, hold and refund intents the run record names; and a cross-check of two
   chain sources: the `Transfer` receipts the escrow emitted in the journey transactions must equal the PAID and
   REFUNDED intents in the views, recipient and amount. Every journey transaction: exists, `FINAL`, succeeded, no
   failed receipt, the stated single method call by the stated signer on the escrow, with an explorer link.
4. **Three outcomes per row: PASS, FAIL, ERROR.** A value that cannot be read (endpoint down, unknown transaction,
   malformed answer) is an ERROR row and makes the verdict FAIL. The verdict is PASS only when there is at least one
   row and all rows passed. A network without a deployment is `NOT_DEPLOYED`: the page shows "Not deployed yet",
   sends no request and makes no claim; judge prints a SKIP row.
5. **Mainnet tab.** `sources.json` lists mainnet with no run, so the manifest has `deployment: null` and the tab
   says "not deployed yet". It fills in only when a mainnet run record is committed and listed.
6. **Endpoints.** Per network a public endpoint first and an archival one second
   (`test.rpc.fastnear.com`, `archival-rpc.testnet.fastnear.com`; the mainnet pair likewise), tried in order, so
   journey transactions stay readable after a non-archival node has garbage-collected them. Both send
   `Access-Control-Allow-Origin: *`.
7. **Page hardening.** Static files only. A content security policy (`default-src 'none'`, scripts and styles from
   the page's own origin, `connect-src` exactly the manifest's endpoints) is checked against the manifest by a
   unit test. No third-party script, font or image; no inline script; chain data is written with `textContent`
   only (a test bans `innerHTML` and friends). The RPC endpoints cannot be overridden from the address bar, so a
   link to the page cannot make it show a pass against another server.
8. **`pnpm judge`.** Steps: frozen install, `pnpm run test`, `pnpm run contract:test`, manifest currency, on-chain
   checks; one table (check, expected, actual, result), full values in `.data/judge/judge-report.json`, exit 0 only
   on PASS. Options `--only`, `--skip`, `--no-code-bytes`, `--manifest`, `--report`; skipped steps are printed as
   SKIP rows and a run with no passing row is a FAIL. The Linux reproduction and the browser suites stay separate
   commands because they need Docker or take longer than the six-minute target.
9. **Pages workflow and the policy.** `.github/workflows/pages.yml` uploads `site/proof` unchanged.
   `scripts/ci/workflow-policy.mjs` gains a `pages` profile, selected by the file name `pages.yml`. Every ADR-0020
   rule still applies to it (triggers push-to-main and pull_request only, `contents: read` at workflow level, no
   secrets, pinned actions with a version comment, no expression in a run script, checkout without credentials,
   timeouts, bash, per-ref concurrency). Differences, each enforced:
   - runner `ubuntu-24.04` only; required command `node scripts/proof/build-manifest.mjs --check` in `build`;
   - `OFFICIAL_ACTIONS`: only `actions/checkout`, `setup-node`, `configure-pages`, `upload-pages-artifact`,
     `deploy-pages`; `PAGES_ARTIFACT`: the uploaded path is `site/proof`;
   - **one exception to the permission rule**: the job `deploy` holds exactly `pages: write` and `id-token: write`,
     which `actions/deploy-pages` requires. In exchange it must have `if: github.event_name == 'push'`, need
     `build`, target the `github-pages` environment and consist of the single `actions/deploy-pages` step: no
     checkout, no script, no inputs. No other job may hold a permission, an environment or a condition.
   The CI profile is unchanged; the same file under another name is refused by it.
10. **Tests without the network.** `scripts/proof/record-fixture.mjs` ran the real verifier against the real
    endpoints once and stored the answers (gas profiles, chunks and merkle proofs removed) in
    `fixtures/proof/testnet-recording.json`. `scripts/proof/replay-rpc.mjs` replays them unchanged or with exactly
    one fact altered per named variant. Unit, judge and browser suites run the real verifier and the real page
    against it. The 1.1 MB `view_code` answer is not recorded; the suites show that row as unreadable with the
    committed manifest and cover its pass and fail with a small test artifact.

## Consequences

- Adding a deployment or a journey to the page is: commit its run record, list it in `sources.json`, run
  `pnpm run proof:manifest`, and re-record the fixture when testnet journeys change.
- The page proves what is on chain. It does not prove who held which key (INV-13 acceptance stays open) and does
  not rebuild the wasm; `pnpm run contract:reproduce` does that.
- GitHub Pages must be enabled by the repository owner with "GitHub Actions" as the source; nothing in this build
  pushed or published.
- The page depends on third-party RPC availability. An outage shows as ERROR rows, not as a pass.
