# Implementation Plan

Status: **SPECIFICATION_ONLY**. Every module is **NOT_RUN**.

## Intake gate

- Verify official event rules, current NEAR SDK/testnet behavior, token standard and RPC. If optional M06 is selected, separately verify the official 1Click client/base configuration, `dry:true` schema, quote expiry, recipient fields, and status semantics; failure leaves the compatibility claim non-passing and does not block `WORKING_TESTNET`.
- Use the selected working asset/corridor: native testnet NEAR directly from escrow to the bound supplier NEAR testnet account. Confirm account/deployment details, signature scheme, persistence, object store, auth provider and browsers.
- Record blockers without substituting mocks for the central path.

## Dependency order

```text
M00 foundation/contracts
  └─ M01 organization/authority
       ├─ M02 NEAR escrow/funding/refund
       └─ M03 evidence/inspection/hold
            └─ M04 integrated release/destination (also depends on M02)
                 └─ M05 journal/reconciliation/outbox
                      ├─ M06 optional payout compatibility/funded authorization
                      └─ M07 integrated API/authority/audit (also depends on M01)
                           └─ M08 professional UI
                                └─ M09 real-product hardening/delivery
```

## Defer order, not quality cuts

If delivery capacity is constrained, defer optional M06 and AI first. Never defer full-predicate revision-bound ManifestAttestor authority, deterministic SET/risk RESOLVE separation, dual-signed CANCEL/objective ABANDON, direct testnet enforcement, refund source buckets, locked UNKNOWN/REVIEW recovery, authoritative failure disposition, actual signatures, destination safety, durability, truthful status, accessibility, or clean-checkout proof.

## Completion rule

A module is complete only when its mapped requirements/invariants are implemented, every owned test has real evidence, dependencies remain green, migrations and threats are reviewed, and the handoff is reproducible. Scaffolding, styled pages, a build, mocks, screenshots, and document QA are insufficient.

M09 must satisfy [REAL-PRODUCT-GATE.md](REAL-PRODUCT-GATE.md) and [CORRIDOR-CONTRACT.md](CORRIDOR-CONTRACT.md) without depending on M06. If M06 is also completed, report its separate `DRY_COMPATIBLE` result. Event artifacts are generated only after the product path works.
