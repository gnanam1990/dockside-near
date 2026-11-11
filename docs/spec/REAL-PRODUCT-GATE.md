# Real Product Gate

Status: **SPECIFICATION_ONLY**  
Runtime result: **NOT_RUN**

Dockside may be called `WORKING` only from observed runtime evidence produced by the exact tested build. An event recording is evidence of that product path; it is never a substitute for it.

## Disallowed substitutes

- Mock, fixture, or in-memory provider on the central claim.
- Seeded database rows presented as completed user actions.
- Hard-coded quote, attestation, approval, transaction, receipt, or status.
- Prerecorded transition, animation, screenshot, or video used as runtime state.
- UI-only denial while the API, worker, contract, or retained key can bypass it.
- Manual database edits or operator intervention needed to reach the shown success.
- Local signature claimed as the enrolled inspector or buyer without proving key enrollment and verification.
- One operator or generic service credential controlling buyer, supplier, inspector, ManifestAttestor, deterministic-policy and risk/policy test keys presented as normal acceptance.
- A `dry:true` quote, provider acknowledgement, source transaction, or explorer link relabelled as destination payment.
- Testnet funds described as mainnet or production customer funds.

## Required runtime evidence

The exact commit and built artifact must produce:

1. clean-checkout setup and pinned dependency evidence;
2. real NEAR testnet deployment and native testnet NEAR funding from a recorded funder, followed by direct same-asset contract release to the bound supplier NEAR testnet account;
3. canonical agreement and authority flow completed by independently enrolled buyer, supplier, inspector and risk/policy principals through separate proof-of-possession sessions;
4. nonempty EvidencePolicy with actual authorized uploads filling every current slot, plus the exact trade/policy-bound ManifestAttestor version signing every uploader, issuer, MIME/content, byte/resource, original/derived-source digest, replacement/currentness, issued/freshness and cardinality fact; caller booleans, wrong-but-enrolled/cross-scope, rotated-unbound/revoked keys and concurrent replacement are rejected;
5. actual inspector signature verified against enrollment and the exact contract-accepted complete manifest digest;
6. actual onchain HoldRecord SET by deterministic policy or risk/policy, deterministic-policy resolution denied, direct contract/API/UI release denied, AI output unable to mutate it, buyer request/view separated from authority, every non-risk resolution signature rejected, and a separate risk/policy resolver verified;
7. stable releaseIntentId locking exact value, dual-signed CANCEL, objective policy-triggered ABANDON and destination supersession verified with nonce/expiry/replay/race enforcement, and actual buyer release signature verified against current facts;
8. forged or unilateral destination change denied at contract/service enforcement; legitimate dual-consent delayed revision invalidates manifest, attestation, hold view, release intent and approval;
9. every versioned refund/recovery reason, exact source-bucket revocation including excess to QUARANTINED, original-funder receipt, unexpected assets and concurrent refund/release paths verified against policy and conservation;
10. durable operation/value lock written before an external attempt; process termination across UNKNOWN/REVIEW/reconciliation/adjudication; authoritative no-transfer failure disposition; late success/refund/contradiction; restart without blind duplicate, second payout or bucket drift;
11. API/UI state sourced from persisted and onchain observations, including incomplete evidence, active/expired hold, `REVIEW`, `UNKNOWN`, refund and recovery;
12. checksummed audit export matching the same identities, manifests, holds, release intent, funder ledgers and outcomes;
13. automated and manual accessibility evidence for the critical workflow.

A live 1Click dry call is not required for `WORKING_TESTNET`. Its independent status is `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `PASS`; only `PASS` supports the optional `DRY_COMPATIBLE` claim.

## Separate funded-mainnet gate

A funded cross-chain payout is `BLOCKED` until the user separately authorizes the exact network, wallet, amount, exposure cap, signing action, and executor. The one permitted design is contract to exact selected 1Click quote deposit address to contract-bound supplier final destination, with `refundTo` controlled by the escrow/refund authority. A post-quote FundedPayoutAuthorization must bind release intent, quote/deposit address, final recipient, networks/assets, input amount, minimum output, fees, slippage, cap, refund authority, nonce, expiry and signer, then be consumed atomically once. `PAID` additionally requires provider terminal success, source-chain evidence, and authoritative destination receipt bound to the original release intent. If this gate is not run, Dockside can be `WORKING_TESTNET` only; it cannot claim working cross-chain settlement.

## Claim vocabulary

- `SPECIFICATION_ONLY`: documents exist; implementation not established.
- `IMPLEMENTED_UNVERIFIED`: code exists but the real gate is incomplete.
- `WORKING_TESTNET`: the direct native testnet NEAR escrow-to-bound-supplier path and every required authority/recovery check above passed for the exact build.
- `DRY_COMPATIBLE`: real provider dry validation passed; no funds moved.
- `WORKING_MAINNET_PAYOUT`: separately authorized funded gate and destination reconciliation passed.
- `BLOCKED`: required authority or capability is absent.

No structural document check, compilation, unit test, CI badge, hosted preview, event submission, or judge recording can promote these states by itself.
