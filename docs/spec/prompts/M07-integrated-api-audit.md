# M07 — Integrated API, authority and audit

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependencies: M01, M05. M06 is optional and is not a prerequisite.

Mapped IDs: FR-09, FR-10, FR-15, NFR-02, NFR-04, NFR-06, INV-01, INV-07, INV-08, INV-13, T-003, T-033, T-034, T-035, T-052, T-053.

Implement typed API/auth/session/CSRF/origin/idempotency/optimistic controls across every completed core module. Expose ManifestAttestor enroll/prove/grant/rotate/revoke/status and CANCEL/ABANDON flows without weakening contract authority. The buyer can request/view hold resolution; deterministic policy may SET only; only a separate current risk/policy resolver may RESOLVE. Explicitly deny every other actor and prove API release stays denied under active/expired holds. Reconciliation/adjudication endpoints request work only and cannot force a terminal status. Implement append-only audit/export covering service key versions/scopes, manifest predicate facts, exit signatures, holds, locks, source buckets, observations and contradictions.

Drive cross-role/direct-boundary, concurrent worker, stale revision, export tamper, secret canary and enumeration tests. UI flags never become authority. Record exact actual-boundary evidence.
