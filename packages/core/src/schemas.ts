import { type ZodError, type ZodTypeAny, z } from "zod";
import { DocksideError, fail } from "./errors.js";
import {
  DEFAULT_JSON_LIMITS,
  isWellFormed,
  type JsonLimits,
  type JsonValue,
  parseStrictJson,
} from "./json.js";

/**
 * Boundary validation helpers. Every external payload goes:
 *   raw bytes -> parseStrictJson (duplicate keys, limits) -> version dispatch
 *   -> strict zod schema (unknown fields rejected) -> typed value.
 */
export function zodToDockside(err: ZodError): DocksideError {
  const issue = err.issues[0];
  if (issue === undefined) return new DocksideError("VALIDATION_FAILED", "invalid payload");
  const path = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    return new DocksideError("UNKNOWN_FIELD", "payload contains unknown fields", {
      path,
      fields: issue.keys.slice(0, 8).join(","),
    });
  }
  // Codec failures raised inside transforms keep their specific code.
  const custom = issue as { params?: { docksideCode?: string } };
  const code = custom.params?.docksideCode;
  if (code !== undefined) return new DocksideError(code as DocksideError["code"], issue.message, { path });
  return new DocksideError("VALIDATION_FAILED", issue.message, { path });
}

export function parseWith<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw zodToDockside(r.error);
  return r.data;
}

/** Wrap a throwing codec as a zod transform that preserves the Dockside error code. */
export function codec<T>(fn: (s: string) => T) {
  return (s: string, ctx: z.RefinementCtx): T => {
    try {
      return fn(s);
    } catch (e) {
      if (e instanceof DocksideError) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: e.message, params: { docksideCode: e.code } });
        return z.NEVER;
      }
      throw e;
    }
  };
}

/** C0/C1 controls (except tab, LF, CR) and Unicode bidirectional overrides/isolates. */
export function hasForbiddenControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

/** NFC-normalised, well-formed, bounded free text. Normalisation happens before signing. */
export function text(maxChars: number) {
  return z
    .string()
    .refine(isWellFormed, { message: "text contains an unpaired surrogate" })
    .transform((s) => s.normalize("NFC"))
    .refine((s) => s.length > 0 && s.length <= maxChars, {
      message: `text must be 1..${maxChars} characters`,
    })
    .refine((s) => !hasForbiddenControl(s), {
      message: "text contains control or bidirectional-override characters",
    });
}

export const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32-byte lowercase hex digest");
export const epochMs = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected lowercase slug");

/**
 * Parse a versioned raw payload: duplicate keys and limits at the raw boundary, then
 * dispatch on `schemaVersion`. Unsupported versions fail closed.
 */
export function parseVersioned<T>(
  raw: string | Uint8Array,
  versions: Readonly<Record<number, (value: JsonValue) => T>>,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): T {
  const value = parseStrictJson(raw, limits);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("VALIDATION_FAILED", "payload must be a JSON object");
  }
  const v = (value as Record<string, JsonValue>)["schemaVersion"];
  if (typeof v !== "number") fail("UNSUPPORTED_VERSION", "payload is missing a numeric schemaVersion");
  const handler = versions[v];
  if (handler === undefined) fail("UNSUPPORTED_VERSION", "unsupported schemaVersion", { schemaVersion: v });
  return handler(value);
}
