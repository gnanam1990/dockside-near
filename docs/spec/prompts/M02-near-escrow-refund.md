# M02 — NEAR escrow, funding and refund

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependencies: M00, M01.

Mapped IDs: FR-02, FR-14, NFR-01, NFR-02, INV-02, INV-12, T-007, T-008, T-051.

Implement the exact corridor in CORRIDOR-CONTRACT.md: native testnet NEAR into escrow, per-deposit original funder, direct same-asset supplier release primitive, partial/unavailable funding and excess quarantine. Implement the lower-layer records, source buckets, clocks, signatures, revocation and unresolved-state primitives required by `dockside-refund-v1` revision 1. Pre-execution revocation restores the exact source bucket and excess always returns to `QUARANTINED`. Unsupported assets never enter native-NEAR accounting; record them only in separate asset-recovery review with no fabricated owner or unilateral withdrawal. Inspector-fail, permanent-hold and full row integration are tested in M04 after M03 exists.

Start with real contract/sandbox failures across every reason-row field, unexpected assets and original-funder identity. The lower-layer escrow/refund primitives must preserve per-asset/per-funder conservation; the integrated refund-versus-release race is owned by M04 after release and hold enforcement exist. Testnet deployment/funding remains an external gate and must be recorded only when actually authorized and run.
