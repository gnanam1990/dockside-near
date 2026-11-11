# Delivery and Repository Contract

Status: **SPECIFICATION_ONLY**. No repository mutation, push, PR, merge, deploy, signing, funding, publication, or submission is authorized by this pack.

## Repository intake

1. Read repository `AGENTS.md` and all scoped instructions.
2. Record absolute checkout, remote identity, default branch, exact base SHA, dirty state, worktrees, toolchain, and secret-variable names without values.
3. Confirm whether a repository exists. Do not invent history or overwrite user changes.
4. Create local focused branches only when implementation is explicitly invoked in that repository.
5. Reconcile proposed versions and commands with installed toolchain and official docs.

## Module delivery

For each `M00`–`M09`:

1. verify dependency handoffs and ancestor SHAs;
2. reproduce the owned red cases and retain redacted evidence;
3. implement only the accepted module boundary;
4. run format, static analysis, focused tests, dependency and impacted regression suites;
5. update `BUILD-STATUS.md` with exact commands, exit codes, counts, runtime boundaries, commit, and gaps;
6. make focused local commits with no unrelated formatting or generated secrets;
7. inspect the full diff against `CORE-CONTRACT.md`, `SECURITY.md`, and the prompt;
8. prepare a PR body from `templates/PR-BODY.md`.

After separate authorization, push and open the PR. CI and review are evidence, not merge permission. Require green checks and resolved findings, then merge only under a separately explicit instruction. Verify the resulting default-branch SHA and rerun proportionate smoke tests.

## Commit and PR map

| Module | Suggested branch | Required proof |
|---|---|---|
| M00 | `feat/foundation-contracts` | canonical identity and schema fail-closed proof |
| M01 | `feat/organization-authority` | human/service PoP, attestor scope/custody, rotation/revocation |
| M02 | `feat/near-escrow-refund` | native NEAR, source buckets, excess quarantine, asset isolation |
| M03 | `feat/evidence-inspection-hold` | every predicate, bound attestor lifecycle, SET/RESOLVE separation |
| M04 | `feat/integrated-release` | refund-row integration, hold denial, CANCEL/ABANDON/supersede races |
| M05 | `feat/reconciliation-journal` | unresolved locks, authoritative failure, restart/late/contradiction recovery |
| M06 (optional) | `feat/oneclick-authorization` | independent dry claim state, exact blocked funded design |
| M07 | `feat/api-audit` | integrated role enforcement, concurrency, export |
| M08 | `feat/product-ui` | actual backend E2E, accessibility, responsive |
| M09 | `feat/real-product-hardening` | clean checkout, packaged artifact, exact evidence |

## External-action gates

The following each require exact, separate authority: remote repository creation; push; PR opening; merge; visibility change; hosting; contract deployment; wallet/signature; testnet or mainnet funding; provider credential creation/use; funded payout; public demo recording; publication; X post; event submission; terms acceptance.

## Evidence hierarchy

- Document checker: structure only.
- Unit/integration tests: bounded implementation behavior.
- Real testnet contract: actual `WORKING_TESTNET` integration evidence for the exact build.
- Optional provider dry probe: evidence only for the separate `DRY_COMPATIBLE` claim.
- Mainnet funded/destination reconciliation: separate product capability.
- Video: recording of already verified behavior, not verification by itself.

See [REAL-PRODUCT-GATE.md](REAL-PRODUCT-GATE.md). The public README must provide “do X, see Y” steps, exact supported environment, real versus blocked capability labels, sibling-project disclosure, baseline/reuse disclosure, architecture, security boundary, and tested commit.
