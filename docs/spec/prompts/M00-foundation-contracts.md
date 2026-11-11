# M00 — Foundation and contracts

Artifact status: **SPECIFICATION_ONLY**. Module status: **NOT_RUN**. Dependencies: none.

Mapped IDs: FR-01, NFR-02, NFR-05, INV-01, INV-08, T-001, T-002.

Read the master prompt and core contract. Establish the real workspace, strict shared types, versioned schemas, canonical length-prefixed identity, amount/address codecs, role/authority model, error taxonomy, clock/ID abstraction, configuration validation, and migration/test foundations. Select exact dependencies only after repository/toolchain review and pin them. No network provider or UI success is needed here.

Start with failing canonicalization and unknown-field tests. Include Unicode, duplicate JSON keys at the raw boundary, unsupported versions, long identifiers, address normalization and wrong-domain signatures. Implement deterministic bytes shared between contract/service tests; do not duplicate weaker algorithms. Integrated cross-role authority belongs to M07 after all enforcement layers exist.

Run format, lint, type, unit/property, schema, and security checks. Record exact results and a dependency handoff in `BUILD-STATUS.md`. Do not push, deploy, sign, fund, or publish.
