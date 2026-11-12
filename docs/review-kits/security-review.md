# Independent security review

A briefing for a security reviewer who has not worked on Dockside: what is in scope, the threat model in short,
where each control lives in the code, the questions to answer for every requirement of
[SECURITY.md](../spec/SECURITY.md), how to run the test suites, and a findings template.

SECURITY.md ends with: "Security review must test actual contract, service, packaged worker, and deployed
headers. A checklist alone is not evidence." Treat the questions below as a starting map, not as the review.
Every answer should point at code you read and a test or experiment you ran.

## 1. Scope

**In scope** (one commit; record its SHA):

| Area | Location |
|---|---|
| Escrow contract (Rust, NEAR) | `contract/crates/dockside-escrow` (entry points), `contract/crates/dockside-escrow-core` (rules), `contract/crates/dockside-canonical` (encoding), `contract/integration` (near-sandbox suites) |
| Shared core: canonical encoding, signatures, schemas, roles, config | `packages/core/src` |
| Authority: bootstrap, sessions, invitations, grants, keys, recovery, service custody | `packages/authority/src` (`service.ts`, `isolated-signer.ts`), `packages/authority/signer/` |
| Evidence, holds, inspection, advisory findings | `packages/evidence/src` (`sniff.ts`, `check.ts`, `policy.ts`, `holds.ts`, `advisory.ts`, `objects.ts`) |
| Release intents, exits, destination change | `packages/release/src/release-service.ts` |
| Journal, outbox, reconciliation, relayer nonces, asset recovery | `packages/journal/src` |
| NEAR RPC client and transaction seam | `packages/near/src` (`rpc.ts`, `tx.ts`, `escrow.ts`) |
| Persistence | `packages/store/src` |
| HTTP API: routing, limits, headers, origin checks, refunds, settings, export signing | `services/api/src` (`app.ts`, `routing.ts`, `limits.ts`, `trades.ts`, `refunds.ts`, `assets.ts`, `settings.ts`, `export*.ts`, `near-accounts.ts`), `services/api/src/cli` |
| Worker | `services/worker/src` |
| Web client: device keys, request proofs, signing review, CSP | `apps/web/src/lib` (`keys.ts`, `signing.ts`, `canonical.ts`, `api/client.ts`, `export-verify.ts`, `wallet.ts`), `apps/web/vite.config.ts` |
| Supply chain and delivery | `pnpm-lock.yaml`, `contract/Cargo.lock`, `.github/workflows/ci.yml`, `scripts/ci`, `scripts/secret-scan.mjs`, `scripts/build-manifest.mjs`, `scripts/container-reproduce.*`, `scripts/testnet-deploy` |

Background reading, in order: [ADR-0003](../adr/0003-authority-sessions-and-service-custody.md) (sessions and
custody), [ADR-0004](../adr/0004-near-escrow-contract.md), [ADR-0005](../adr/0005-evidence-inspection-holds.md),
[ADR-0006](../adr/0006-release-intents-exits-destination.md), [ADR-0007](../adr/0007-journal-outbox-reconciliation.md),
[ADR-0009](../adr/0009-integrated-api-authority-audit.md), [ADR-0018](../adr/0018-settings-signed-export-and-wallet-ownership.md),
then the module status files in [`docs/status/`](../status/).

**Out of scope, or known not built** (report only if you find the claimed boundary is false):

- A live NEAR testnet deployment, unless the owner gives you one; then the deployed headers in §4.4 are in scope.
- The relayer `TxSigner` with real custody: not built; the worker refuses to start without it (exit 78).
- The 1Click adapter and any funded or mainnet payout: blocked at startup and in the contract's `new`.
- HSM or KMS custody of the audit-export key: an isolated signer process stands behind the `ExportKeySigner`
  seam.
- Retention deletion and tombstones: not built (settings and preview only).
- A trade revision that replaces a participant or service: not built.

The full list with reasons is the "Blocked or not run" table in [BUILD-STATUS.md](../../BUILD-STATUS.md).

## 2. Threat model in short

Assets: escrowed value and release authority; every party and service key and capability; the bound payout
destination; commercial documents and private evidence; the journal, audit history and receipts.

Adversaries the design must withstand (SECURITY.md "Adversaries and failures"):

1. A forged or compromised supplier account asking for a new payout destination.
2. Any role or service exceeding its role, or reusing a key outside its trade or policy scope.
3. Malicious evidence attacking parsers, or prompt-injecting the analysis model.
4. A compromised browser or API manufacturing "ready" or "paid".
5. RPC or provider timeouts hiding an accepted economic action.
6. Replays, stale signatures, key rotation, clock skew, worker races.
7. One operator, one service credential or a stolen session acting as several principals.
8. Evidence presented as complete when it is not (caller booleans, altered facts, the wrong attestor or key).
9. Model output or an expired hold used to create, clear or bypass authority.
10. Release, refund, destination activation or renewal racing an unknown payout.
11. Forged, replayed or one-sided CANCEL; early ABANDON; exiting a submitted intent.
12. Failure inferred from a provider error; REVIEW unlocked; late success conflicting with a successor; excess
    refund revocation restored outside `QUARANTINED`.
13. Refund reason, clock, recipient, amount or asset classification altered outside the versioned policy.
14. Secrets leaking through logs, traces, exports, DOM, storage, accessibility text or screenshots.
15. Dependency, CI, deployment, DNS, origin, webhook, storage or backup compromise.

The central design claim: **the contract enforces value movement**; API projections and UI states have no
authority. Most findings worth having are a path where something other than the contract decides.

## 3. Questions per requirement

IDs are for the findings template. "Tests" names suites to read and extend; a passing suite is not an answer.

### SR-1 Contract-side enforcement (Mandatory controls, first bullet)

Code: `contract/crates/dockside-escrow-core/src/{release,evidence,holds,destination,refund,ledger,trade}.rs`.
Tests: `packages/release/test/m04-release-wasm.test.ts`, `packages/evidence/test/m03-contract-wasm.test.ts`,
`packages/near/test/m02-escrow-wasm.test.ts`, `contract/integration/sandbox-tests`.

- Can any entry point move native NEAR to anyone other than the bound supplier on release or the original funder
  on refund?
- Does release recompute manifest completeness from the bound ManifestAttestor's signed facts, or can any
  caller-supplied field (a `complete` flag, a digest, a slot count) influence it?
- Is every predicate in INV-09 to INV-16 of [CORE-CONTRACT.md](../spec/CORE-CONTRACT.md) checked in the contract,
  not only in the API?
- Is there any owner, admin or upgrade path that bypasses these rules? What does `new` accept?

### SR-2 Canonical digests and signatures

Code: `packages/core/src/{canonical,signing,crypto}.ts`, `contract/crates/dockside-canonical`,
`contract/crates/dockside-escrow-core/src/{crypto,domains}.rs`, `apps/web/src/lib/canonical.ts`.
Tests: `packages/core/test/t001-*.test.ts`, `t002-*.test.ts`, `fixtures/canonical-vectors.json`.

- Are domains separated so a signature for one purpose cannot be replayed as another?
- Are nonce, expiry, chain ID and contract ID inside every signed payload, and checked?
- Can two different objects encode to the same bytes (Unicode, number forms, duplicate keys, unknown fields)?
- Are the TypeScript, browser and Rust encoders byte-identical for adversarial input, not only the vectors?

### SR-3 ManifestAttestor enrollment and custody

Code: `packages/authority/src/{service,isolated-signer}.ts`, `packages/evidence/src/check.ts`.
Tests: `packages/authority/test/t004-*`, `t006-*`, `packages/evidence/test/m03-t017-t049-attestation.test.ts`.

- Is enrollment proof-of-possession, restricted to security administrators, and scoped to organization, trade and
  policy?
- Is the attestor key bound to the active trade revision, so a rotated key cannot sign for an old binding and an
  old key cannot sign after rotation without a new revision?
- Does the isolated signer refuse purposes outside its allowlist? Can the API process reach the key?
- Are custody locators that look like key material rejected?

### SR-4 Least privilege and separation of duties

Code: `packages/core/src/roles.ts`, `packages/authority/src/service.ts`, `services/api/src/trades.ts`,
`contract/crates/dockside-escrow-core/src/holds.rs`.
Tests: `services/api/test/m07-t003-authority-matrix.test.ts`, `m07-t052-t053-holds.test.ts`.

- Check each row of the SECURITY.md authorization matrix against the API and the contract. Which rows are
  enforced only in the API?
- Can deterministic policy ever RESOLVE a hold? Can anyone but the enrolled risk/policy principal?
- Can one principal end up holding two party capabilities, or a party capability plus `ORG_SECURITY_ADMIN`?
- Can one human obtain two principals in one organization and act as buyer and supplier on one trade? (The design
  requires different organizations for buyer and supplier; check where.)

### SR-5 Sessions, origin, headers, rate limits

Code: `services/api/src/{app,limits,routing}.ts`, `packages/authority/src/service.ts` (sessions and request
proofs), `apps/web/src/lib/{keys,api/client}.ts`, `apps/web/vite.config.ts`.
Tests: `services/api/test/api-authority.test.ts`, `m09-hardening.test.ts`.

- SECURITY.md asks for "HttpOnly secure same-site cookies or equivalent". This build uses a session token in
  `sessionStorage` plus a per-request Ed25519 proof from a non-extractable WebCrypto key (ADR-0003 §2,
  ADR-0008). Is that equivalent? What does an XSS on the origin gain?
- Is the request proof bound to origin, method, path and query, and body hash, with a bounded window and a
  durable nonce? Is a proof replayable across sessions?
- Which requests are refused for a wrong `Origin`? Is CSRF possible on any state-changing route?
- Are CSP, HSTS, `frame-ancestors`, CORP and COOP set on both the API and the served web app? Is HSTS only sent
  where it should be?
- Are unauthenticated challenge creation and per-session requests rate-limited? Is the limiter keyed so a client
  cannot evade it by changing a header?

### SR-6 Evidence handling

Code: `packages/evidence/src/{sniff,objects,evidence-service,policy}.ts`, `services/api/src/trades.ts` (upload
route and body limits).
Tests: `packages/evidence/test/m03-t011-t012-slots.test.ts`, `m03-t013-t018-replacement.test.ts`.

- Is the upload streamed with a hard byte limit before any parsing? What happens with a decompression bomb, a
  huge image, a polyglot file, a wrong extension?
- Is MIME detected from content, not the client's claim? Is active content (HTML, SVG, scripts) isolated or
  refused?
- Is evidence encrypted at rest, and are downloads short-lived and authorized? (Check `objects.ts`; report what
  is and is not done.)
- Is there malware scanning, or an explicit boundary saying where it would sit?

### SR-7 Model output is untrusted

Code: `packages/evidence/src/advisory.ts`, `packages/evidence/src/holds.ts`.
Tests: `packages/evidence/test/m03-t014-t016-holds.test.ts`.

- Can any code path take model output and SET, RESOLVE or otherwise affect a HoldRecord or other authority?
- Is model input minimized? Is the review text bounded and encoded safely when displayed?

### SR-8 Provider and RPC boundary

Code: `packages/near/src/rpc.ts`, `services/api/src/settings.ts` (RPC endpoint settings),
`packages/payout/src`.
Tests: `packages/near/test/m02-rpc-client.test.ts`, `m17-rpc-real-node-shapes.test.ts`.

- Is there an endpoint allowlist, TLS validation, a timeout and a response size limit on every call?
- Can an administrator, a setting or evidence content supply a URL the server will fetch (SSRF)?
- Are responses schema-validated, and are unexpected shapes treated as `UNKNOWN` rather than success or failure?

### SR-9 Outbox, idempotency, leases and the release-intent lock

Code: `packages/journal/src/{journal,engine,decide,states,relayer}.ts`, `packages/release/src/release-service.ts`,
`contract/crates/dockside-escrow-core/src/release.rs`.
Tests: `packages/journal/test/m05-*.test.ts`, `m15-*.test.ts`, `services/worker/test/*`,
`services/api/test/m07-t035-concurrency.test.ts`.

- Is the value lock written durably before any external attempt?
- Are leases fenced, so a paused worker that resumes cannot submit with a stale lease?
- Is any competing action (renewal, second intent, destination activation, cancel, abandon, refund) possible while
  an intent is `SUBMITTING`, `PROCESSING`, `UNKNOWN`, `REVIEW`, `RECONCILING` or `ADJUDICATION`?
- CANCEL: are both signatures over the same canonical payload, role-bound, nonce-protected and current? ABANDON:
  is the trigger objective and policy-bound, and the signer only the designated buyer approver or supplier
  signer?

### SR-10 Terminal states and late evidence

Code: `packages/journal/src/{decide,states}.ts`, `contract/crates/dockside-escrow-core/src/{release,ledger}.rs`.
Tests: `packages/journal/test/m05-release-journal.test.ts`, `m05-process-kill.test.ts`.

- Can `FAILED` be reached without authoritative no-transfer proof plus escrow accounting?
- Can adjudication force a terminal state?
- Does a late success or refund after `UNKNOWN`/`REVIEW`, or a contradiction after `FAILED`, freeze the original
  and any successor?

### SR-11 Refund policy and unexpected assets

Code: `contract/crates/dockside-escrow-core/src/{refund,assets,ledger}.rs`, `services/api/src/{refunds,assets}.ts`,
`packages/journal/src/assets.ts`. Policy: [REFUND-POLICY.md](../spec/REFUND-POLICY.md).
Tests: `services/api/test/m10-refund-routes.test.ts`, `m15-refund-reasons.test.ts`,
`m11-asset-recovery-routes.test.ts`, `packages/near/test/m11-asset-recovery-wasm.test.ts`.

- Does each refund reason check policy ID and revision, initiator, signers, clock origin and duration, evidence,
  challenge, eligible amount, original-funder recipient and source bucket in the contract?
- Does revocation restore the exact source bucket, including `EXCESS_FUNDING_RETURN -> QUARANTINED`?
- Can an unexpected token or NFT ever increase a native-NEAR ledger field, or be withdrawn unilaterally?

### SR-12 Secrets

Code: `scripts/secret-scan.mjs`, `packages/core/src/config.ts`, `services/api/src/app.ts` (logging and
redaction), `services/api/src/export.ts`.
Tests: `services/api/test/m07-t034-redaction.test.ts`, the T-034 browser test in `apps/web/e2e/product.spec.ts`.

- Is any secret (session token, invitation secret, private key, custody locator, export key) ever logged,
  returned twice, written to the audit log, exported, put in the DOM or browser storage, or used as an
  accessible name?
- Are secrets only injected from the environment or a secret manager? Does configuration fail closed on unknown
  or unsafe values?

### SR-13 Supply chain and delivery

Code: `pnpm-lock.yaml`, `contract/Cargo.lock`, `.github/workflows/ci.yml`, `scripts/ci/workflow-policy.mjs`,
`scripts/build-manifest.mjs`, `scripts/container-reproduce.*`, `scripts/testnet-deploy`.
Docs: [ADR-0015](../adr/0015-status-consolidation-and-linux-reproduction.md),
[ADR-0019](../adr/0019-sandbox-chain-tests-and-run-all.md), [ADR-0020](../adr/0020-continuous-integration-and-consolidation.md).

- Are dependencies pinned and the lockfiles enforced (`--frozen-lockfile`, `--locked`)? Any install scripts?
- Are CI actions pinned by SHA, with read-only permissions and no secrets? Does the policy check catch a change
  that weakens this?
- Is the deployable wasm reproducible, and does `run-all` refuse a wasm whose digest differs from the manifest?
- Are downloaded tools (near-sandbox, near-cli-rs) pinned by digest?

### SR-14 Privacy and retention (SECURITY.md "Privacy and retention")

- Do default exports exclude raw evidence and full destinations? Are onchain records limited to digests and
  minimum authority facts?
- What happens to evidence after the retention period, given deletion is not built?

### SR-15 Incident behaviour (SECURITY.md "Incident behavior")

- On suspected key compromise, can an administrator freeze new authority and see the affected trades?
- On a conservation failure, are releases blocked?
- On a database and object-store mismatch, is the trade held?

## 4. How to run the suites

Prerequisites: Node 22 (`>=22.13 <23`), pnpm 10, Rust stable with `wasm32-unknown-unknown`, git; Docker for the
container and nearcore suites (on Windows, a Docker Engine inside WSL 2).

```sh
pnpm install --frozen-lockfile
pnpm run check              # format, lint, typecheck, unit and integration tests, secret scan
pnpm run contract:test      # contract host tests
pnpm run web:e2e            # browser suites against the local stack (Playwright with axe)
pnpm run ci:policy          # CI workflow policy check
pnpm audit --prod           # known vulnerabilities in production dependencies
pnpm run contract:sandbox   # contract on a local nearcore node (Docker)
pnpm run contract:reproduce # clean clone and deployable wasm in a Linux container (Docker)
```

Run one test file: `pnpm exec vitest run services/api/test/m07-t003-authority-matrix.test.ts`.

To experiment against a running system, start the local stack (see
[scripts/local-stack/README.md](../../scripts/local-stack/README.md)): it runs the real API and worker over a
simulated chain. Its control port is a test harness, loopback only, and is not part of the product's attack
surface; do not report that it has no authentication.

Expected counts and exit codes for the recorded build are in the latest status file under
[`docs/status/`](../status/).

### 4.4 Deployed headers

If the owner gives you a deployment (USER-NEXT-STEPS §5), check the real responses, not the code:

```sh
curl -sSI https://<web origin>/
curl -sSI https://<web origin>/readyz
curl -sS  https://<web origin>/readyz        # network: near-testnet, fundedPayouts: BLOCKED
curl -sSI -H "Origin: https://example.invalid" -X POST https://<web origin>/v1/<any state-changing route>
```

Record CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, COOP, CORP and `frame-ancestors`, the TLS
configuration, and what a wrong `Origin` returns.

## 5. Severity

| Severity | Meaning |
|---|---|
| Critical | Value can move to a party other than the bound supplier or original funder, or authority can be forged |
| High | A role can exceed its authority, a lock can be bypassed, or a secret can leak, under realistic conditions |
| Medium | A control is weaker than specified, or holds only in the API or UI, with no known exploit path to value |
| Low | Hardening, defence in depth, unclear error handling |
| Info | Observations and documentation gaps |

## 6. Findings template

Copy into a new file (for example `docs/evidence/security-review-<date>.md`). Do not include working exploit
keys or real secrets; describe them.

```text
Independent security review
Reviewer:                       Dates (UTC):
Commit SHA:                     Deployment reviewed: [ ] none  [ ] testnet (origin, escrow account, code hash)
Suites run (command, exit code, counts):
  pnpm run check:
  pnpm run contract:test:
  pnpm run web:e2e:
  pnpm audit --prod:
  other:

Coverage
| Requirement | Reviewed (code read, experiment) | Result: OK / finding IDs / not reviewed |
|-------------|----------------------------------|-----------------------------------------|
| SR-1 Contract-side enforcement      |  |  |
| SR-2 Digests and signatures         |  |  |
| SR-3 ManifestAttestor custody       |  |  |
| SR-4 Least privilege                |  |  |
| SR-5 Sessions, origin, headers      |  |  |
| SR-6 Evidence handling              |  |  |
| SR-7 Model output untrusted         |  |  |
| SR-8 Provider and RPC boundary      |  |  |
| SR-9 Outbox, leases, value lock     |  |  |
| SR-10 Terminal states, late evidence|  |  |
| SR-11 Refunds, unexpected assets    |  |  |
| SR-12 Secrets                       |  |  |
| SR-13 Supply chain, delivery        |  |  |
| SR-14 Privacy, retention            |  |  |
| SR-15 Incident behaviour            |  |  |
| Authorization matrix rows           |  |  |
| Deployed headers (4.4)              |  |  |

Findings
ID:            S-01
Title:
Severity:      Critical / High / Medium / Low / Info
Requirement:   SR-n (and SECURITY.md line, INV or T-ID if applicable)
Location:      file and function, or route, or contract method
Description:
Reproduction:  exact steps or test; attach a failing test if possible
Evidence:      output, exit code, redacted logs
Impact:
Recommendation:
Status:        open / fixed in <commit> / accepted risk (by whom)

Summary and overall opinion:
```

The owner answers each finding, links the fixing commit and its test, and records the review in
[BUILD-STATUS.md](../../BUILD-STATUS.md).
