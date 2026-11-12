import { z } from "zod";
import { NETWORKS, parseNearAccountId } from "./codecs.js";
import { DocksideError, fail } from "./errors.js";
import { codec } from "./schemas.js";

/**
 * Runtime configuration from environment variables. Fails closed: unknown DOCKSIDE_*
 * variables (typos) and invalid values stop startup. Values are never echoed in errors.
 */
const MS_DAY = 24 * 3600 * 1000;

const schema = z
  .object({
    DOCKSIDE_DB_PATH: z.string().min(1).default(".data/dockside.sqlite"),
    DOCKSIDE_ORIGIN: z
      .string()
      .url()
      .refine((u) => {
        const url = new URL(u);
        const local =
          url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
        return url.protocol === "https:" || (url.protocol === "http:" && local);
      }, "origin must be https, or http on a loopback host")
      .refine((u) => new URL(u).origin === u, "origin must not contain a path, query or trailing slash")
      .default("http://localhost:8787"),
    DOCKSIDE_HOST: z.string().default("127.0.0.1"),
    DOCKSIDE_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
    DOCKSIDE_NETWORK: z.enum(NETWORKS).default("near-testnet"),
    DOCKSIDE_ESCROW_CONTRACT_ID: z
      .string()
      .transform(codec((s) => parseNearAccountId(s, {})))
      .optional(),
    /** NEAR JSON-RPC endpoint for the escrow views (M07 trade routes). Host must be https or loopback. */
    DOCKSIDE_NEAR_RPC_URL: z
      .string()
      .url()
      .refine((u) => {
        const url = new URL(u);
        const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
        return url.protocol === "https:" || (url.protocol === "http:" && local);
      }, "RPC endpoint must be https, or http on a loopback host")
      .optional(),
    /** Directory for content-addressed evidence objects (M03 LocalObjectStore). */
    DOCKSIDE_OBJECT_STORE_DIR: z.string().min(1).default(".data/objects"),
    DOCKSIDE_CHALLENGE_TTL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(15 * 60_000)
      .default(5 * 60_000),
    /**
     * Lifetime of a key-recovery (RECOVERY_KEY) challenge (M14). The package is handed to the
     * principal out of band, so it has its own setting; an expired one is re-issued by a
     * security administrator. Defaults to the general challenge lifetime when unset.
     */
    DOCKSIDE_RECOVERY_CHALLENGE_TTL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(24 * 3600_000)
      .optional(),
    DOCKSIDE_SESSION_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(MS_DAY)
      .default(8 * 3600_000),
    DOCKSIDE_INVITATION_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(14 * MS_DAY)
      .default(3 * MS_DAY),
    DOCKSIDE_RECOVERY_DELAY_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * MS_DAY)
      .default(2 * MS_DAY),
    /**
     * Destination-change delay that new trade proposals bind into `delayPolicy` (TDD: "a configurable
     * minimum delay begins only after both valid consents"). The contract enforces the value the
     * parties signed; this setting only chooses what a new proposal carries. Never below one minute.
     */
    DOCKSIDE_DESTINATION_CHANGE_DELAY_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(30 * MS_DAY)
      .default(MS_DAY),
    DOCKSIDE_REQUEST_PROOF_SKEW_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
    DOCKSIDE_FUNDED_PAYOUTS: z.enum(["BLOCKED"]).default("BLOCKED"),
    /** Requests per minute per client address on unauthenticated routes (challenges, logins, invitations). */
    DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(300),
    /** Requests per minute per presented session token on authenticated routes. */
    DOCKSIDE_RATE_LIMIT_SESSION_PER_MIN: z.coerce.number().int().min(1).max(1_000_000).default(3000),
    DOCKSIDE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict();

export type DocksideConfig = z.output<typeof schema>;

export function loadConfig(env: Readonly<Record<string, string | undefined>>): DocksideConfig {
  const relevant: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("DOCKSIDE_") && v !== undefined) relevant[k] = v;
  }
  const r = schema.safeParse(relevant);
  if (!r.success) {
    const issue = r.error.issues[0];
    if (issue?.code === "unrecognized_keys") {
      fail("CONFIG_INVALID", "unknown DOCKSIDE_* configuration variable", { names: issue.keys.join(",") });
    }
    // Only the variable name is reported; values may be sensitive.
    throw new DocksideError("CONFIG_INVALID", "invalid configuration value", {
      name: String(issue?.path[0] ?? ""),
    });
  }
  if (r.data.DOCKSIDE_NETWORK === "near-mainnet") {
    fail(
      "CONFIG_INVALID",
      "near-mainnet is BLOCKED until separately authorized; only near-testnet is supported",
    );
  }
  return Object.freeze(r.data);
}

/** Names of configuration keys that hold secrets; redacted from any diagnostic output. */
export const SECRET_CONFIG_KEYS: readonly string[] = [];

export function redactConfig(c: DocksideConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) out[k] = SECRET_CONFIG_KEYS.includes(k) ? "[REDACTED]" : v;
  return out;
}
