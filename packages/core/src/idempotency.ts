import { type CanonicalValue, canonicalDigestHex } from "./canonical.js";
import { fail } from "./errors.js";

/**
 * Idempotency contract: (scope, key) identifies one logical request. The first
 * accepted request stores the canonical digest of its material input. An exact
 * repeat returns the stored outcome; reuse with any different material fails closed.
 */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export function parseIdempotencyKey(raw: unknown): string {
  if (typeof raw !== "string" || !IDEMPOTENCY_KEY.test(raw)) {
    fail("VALIDATION_FAILED", "idempotency key must be 16..128 URL-safe characters");
  }
  return raw;
}

export function idempotencyRequestDigest(operation: string, material: CanonicalValue): string {
  return canonicalDigestHex("dockside/idempotency-request", 1, { operation, material });
}

export interface StoredIdempotency {
  readonly requestDigest: string;
  readonly response: string;
}

export type IdempotencyDecision =
  | { readonly kind: "NEW" }
  | { readonly kind: "REPLAY"; readonly response: string };

export function decideIdempotency(
  existing: StoredIdempotency | undefined,
  requestDigest: string,
): IdempotencyDecision {
  if (existing === undefined) return { kind: "NEW" };
  if (existing.requestDigest !== requestDigest) {
    fail("IDEMPOTENCY_CONFLICT", "idempotency key reused with different request material");
  }
  return { kind: "REPLAY", response: existing.response };
}
