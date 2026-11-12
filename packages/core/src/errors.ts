/**
 * Dockside error taxonomy. Every boundary failure maps to exactly one stable code.
 * Codes are part of the public contract; do not rename without an ADR.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: { http: 400, retry: "never" },
  MALFORMED_JSON: { http: 400, retry: "never" },
  DUPLICATE_KEY: { http: 400, retry: "never" },
  UNKNOWN_FIELD: { http: 400, retry: "never" },
  UNSUPPORTED_VERSION: { http: 400, retry: "never" },
  LIMIT_EXCEEDED: { http: 413, retry: "never" },
  INVALID_ADDRESS: { http: 400, retry: "never" },
  AMBIGUOUS_ADDRESS: { http: 400, retry: "never" },
  INVALID_AMOUNT: { http: 400, retry: "never" },
  INVALID_KEY: { http: 400, retry: "never" },
  NON_CANONICAL: { http: 400, retry: "never" },
  SIGNATURE_INVALID: { http: 401, retry: "never" },
  WRONG_DOMAIN: { http: 401, retry: "never" },
  NONCE_REPLAYED: { http: 409, retry: "never" },
  EXPIRED: { http: 401, retry: "never" },
  NOT_YET_VALID: { http: 401, retry: "later" },
  WRONG_ORIGIN: { http: 403, retry: "never" },
  IDEMPOTENCY_CONFLICT: { http: 409, retry: "never" },
  VERSION_CONFLICT: { http: 409, retry: "after-refresh" },
  IMMUTABLE_FIELD: { http: 409, retry: "never" },
  UNAUTHENTICATED: { http: 401, retry: "never" },
  FORBIDDEN: { http: 403, retry: "never" },
  SEPARATION_OF_DUTIES: { http: 403, retry: "never" },
  KEY_REVOKED: { http: 403, retry: "never" },
  KEY_NOT_BOUND: { http: 403, retry: "never" },
  SCOPE_MISMATCH: { http: 403, retry: "never" },
  DELAY_NOT_ELAPSED: { http: 409, retry: "later" },
  NOT_FOUND: { http: 404, retry: "never" },
  INVALID_STATE: { http: 409, retry: "never" },
  CONFIG_INVALID: { http: 500, retry: "never" },
  MIGRATION_FAILED: { http: 500, retry: "never" },
  UPSTREAM_TIMEOUT: { http: 504, retry: "unknown" },
  UPSTREAM_ERROR: { http: 502, retry: "later" },
  UPSTREAM_INVALID: { http: 502, retry: "never" },
  CONTRACT_REJECTED: { http: 409, retry: "never" },
  // Evidence, inspection and hold codes (M03). The escrow contract raises the same names.
  INCOMPLETE: { http: 409, retry: "after-refresh" },
  OVER_CARDINALITY: { http: 409, retry: "never" },
  STALE_ITEM: { http: 409, retry: "never" },
  STALE_MANIFEST: { http: 409, retry: "after-refresh" },
  STALE_REVISION: { http: 409, retry: "after-refresh" },
  MANIFEST_NOT_CURRENT: { http: 409, retry: "after-refresh" },
  UNSUPPORTED_CONTENT: { http: 415, retry: "never" },
  MALICIOUS_CONTENT: { http: 422, retry: "never" },
  POLICY_MISMATCH: { http: 409, retry: "never" },
  DIGEST_MISMATCH: { http: 409, retry: "never" },
  SOURCE_MISMATCH: { http: 409, retry: "never" },
  WRONG_CONTRACT: { http: 409, retry: "never" },
  WRONG_NETWORK: { http: 409, retry: "never" },
  // Release, value-lock, exit and destination codes (M04). The escrow contract raises the same names.
  VALUE_LOCKED: { http: 409, retry: "after-refresh" },
  HOLD_ACTIVE: { http: 409, retry: "later" },
  STALE_LEDGER: { http: 409, retry: "after-refresh" },
  STALE_HOLDS: { http: 409, retry: "after-refresh" },
  NOT_ELIGIBLE: { http: 409, retry: "never" },
  NOTHING_ELIGIBLE: { http: 409, retry: "never" },
  NOT_FULLY_FUNDED: { http: 409, retry: "later" },
  INSPECTION_NOT_PASS: { http: 409, retry: "after-refresh" },
  MANIFEST_CONSUMED: { http: 409, retry: "never" },
  INTENT_EXPIRED: { http: 409, retry: "never" },
  APPROVAL_MISSING: { http: 409, retry: "after-refresh" },
  APPROVAL_EXPIRED: { http: 409, retry: "never" },
  APPROVAL_STALE: { http: 409, retry: "after-refresh" },
  DESTINATION_MISMATCH: { http: 409, retry: "never" },
  PROFILE_MISMATCH: { http: 409, retry: "never" },
  CANCEL_DISAGREEMENT: { http: 409, retry: "never" },
  DESTINATION_CHANGE_PENDING: { http: 409, retry: "never" },
  FUNDED_RAIL_BLOCKED: { http: 409, retry: "never" },
  // Journal, outbox and reconciliation codes (M05).
  TRADE_FROZEN: { http: 409, retry: "never" },
  LEASE_LOST: { http: 409, retry: "later" },
  ILLEGAL_TRANSITION: { http: 409, retry: "never" },
  // Refund requests (M10). The escrow contract raises the same names.
  NO_REFUND_SUBMIT: { http: 409, retry: "never" },
  DISPUTE_NOT_ALLOWED: { http: 409, retry: "never" },
  // Hardening (M09).
  RATE_LIMITED: { http: 429, retry: "later" },
  INTERNAL: { http: 500, retry: "unknown" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class DocksideError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = "DocksideError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  get httpStatus(): number {
    return ERROR_CODES[this.code].http;
  }

  get retryClass(): string {
    return ERROR_CODES[this.code].retry;
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, string | number | boolean | null> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  details: Record<string, string | number | boolean | null> = {},
): never {
  throw new DocksideError(code, message, details);
}

export function isDocksideError(e: unknown, code?: ErrorCode): e is DocksideError {
  return e instanceof DocksideError && (code === undefined || e.code === code);
}
