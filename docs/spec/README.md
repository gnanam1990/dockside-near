# Dockside Build Pack v2.0.0

Dockside is a proposed production-shaped supplier-payment product. Its exact working corridor is native testnet NEAR from buyer-funded escrow directly to a contract-bound supplier account. The signed trade binds one isolated ManifestAttestor version that attests every EvidencePolicy predicate; an independent inspector signs the result; deterministic policy may SET but only a separate risk/policy principal may RESOLVE holds. Buyer approval governs a stable value lock with explicit dual-signed CANCEL, policy-triggered ABANDON, destination supersession and locked post-submit recovery. An optional 1Click dry quote can establish only `DRY_COMPATIBLE`; it is not required for `WORKING_TESTNET` or payment evidence.

This folder is a **SPECIFICATION_ONLY** implementation handoff. Product runtime, tests, deployment, provider integration, funded settlement, market demand, publication, and event submission are **NOT_RUN** or **UNPROVEN** as recorded in `project-metadata.json`.

Begin with [START-HERE.md](START-HERE.md). The exact settlement boundary is in [CORRIDOR-CONTRACT.md](CORRIDOR-CONTRACT.md), refund/recovery authority is in [REFUND-POLICY.md](REFUND-POLICY.md), and product-claim evidence is in [REAL-PRODUCT-GATE.md](REAL-PRODUCT-GATE.md). The sibling event concept is RouteSpec; the two must remain independent repositories and submissions.

Document QA cannot establish product behavior. A coding agent must satisfy the actual integrations and exact-build evidence before any working claim.
