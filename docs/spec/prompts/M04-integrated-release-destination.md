# M04 — Integrated release and destination control

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependencies: M02, M03.

Mapped IDs: FR-05, FR-06, FR-11, NFR-01, NFR-02, INV-03, INV-05, INV-06, INV-09, INV-10, INV-11, INV-12, INV-15, INV-16, T-009, T-010, T-015, T-019, T-020, T-021, T-022, T-023, T-046, T-047, T-050.

Integrate escrow, exact revision-bound ManifestAttestor completeness, inspector pass, authoritative hold predicate, buyer approval, destination, refund rows and value into one contract-enforced decision. Direct contract release must fail under any active or expired-unresolved HoldRecord. CANCEL requires one canonical payload plus matching buyer/supplier role-bound consents, distinct request/role/revocation nonces and current expiries; either party may revoke only its own pending consent and disagreement changes nothing. ABANDON accepts only the designated buyer approver or supplier signer after the contract recomputes an objective trade-policy expiry trigger/grace; administrators and service principals have no authority. Supersession requires destination activation. Each pre-submit exit atomically restores/transfers the exact source bucket and invalidates predecessor authority; a submit race has one winner. All unresolved post-submit/review states block every competing action. Integrate inspector-fail and permanent-hold refund rows here because M02 and M03 now exist.

Drive missing-prerequisite enumeration, direct hold bypass, every refund-row mutation, unauthorized/replay/stale/disagreed CANCEL, early/wrong-policy ABANDON, submit/exit/refund/destination races, reservation double exposure, duplicate intent and all unresolved-state denials first. Real testnet direct release is the positive path; inspection cannot be stubbed.
