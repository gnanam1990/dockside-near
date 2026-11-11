# ADR-0002 — Canonical encoding (DCE-1) and domain-separated signatures

- Decision status: accepted (M00)
- Date and authorship: 2026-11-11, Dockside build stage M00 (coding agent)
- Affected IDs: FR-01, INV-01, INV-08, NFR-02, T-001, T-002; consumed by M01–M07 and the contract

## Context

The spec requires "versioned, length-prefixed, typed, deterministic" canonical serialization shared
between the service and the NEAR contract, domain-separated signatures, nonces, expiry and idempotency.
JSON canonicalization (JCS) is not typed (a number vs a decimal string vs a u128 is ambiguous) and Borsh
has no field names (order-dependent), so neither alone meets "typed + field-order independent".

## Decision

**Dockside Canonical Encoding v1** (`packages/core/src/canonical.ts`, mirrored by
`contract/crates/dockside-canonical`):

- Tagged values: `0x00 null`, `0x01 string` (u32 length, UTF-8, must be NFC and well-formed),
  `0x02 u64`, `0x03 u128` (amounts in yoctoNEAR), `0x04 bool`, `0x05 bytes`, `0x06 list`,
  `0x07 struct` (fields sorted by UTF-8 bytes of name, ASCII identifier names). All integers big-endian.
- Envelope: `"DOCKSIDE\0" | u32 len | domain | u16 schemaVersion | value`; digest = SHA-256(envelope).
- Signatures: Ed25519 over the 32-byte digest. Every purpose has a registered domain
  (`SIGNING_DOMAINS` in `signing.ts`); verifiers always name the domain they expect, so a signature for
  one purpose never verifies as another (`WRONG_DOMAIN`).
- Text is NFC-normalised at the schema boundary *before* signing; the encoder rejects non-NFC input
  rather than normalising silently, so the Rust side never needs Unicode tables.
- Addresses are parsed by a version-pinned NEAR account codec. Signed payloads use `strict` mode;
  operator input uses `input` mode (trim + ASCII lowercase only). Non-ASCII is always `AMBIGUOUS_ADDRESS`.
- Raw JSON is parsed by a strict parser that rejects duplicate keys (including escape-equivalent keys),
  unpaired surrogates, lossy numbers and oversize input before schema validation.
- Human wallet proof-of-possession additionally accepts NEP-413 `signMessage` signatures whose message
  embeds the canonical challenge digest, so a real NEAR wallet can enrol (M01).

## Trust/security impact

Ambiguity is rejected rather than normalised (fail closed). Byte equality across languages is enforced by
`fixtures/canonical-vectors.json` (18 vectors + a signed trade revision) consumed by both test suites.

## Migration and rollback

A new encoding version requires a new domain version (`u16`) and new vectors; old signatures remain
verifiable under their recorded version.

## Verification and flip condition

T-001/T-002 vitest suites and `cargo test` vectors. Flip only if the NEAR contract cannot afford the
encoder's gas cost for large payloads; then commit to a digest-of-digests scheme with new vectors.
