import { z } from "zod";
import { NETWORKS, parseNearAccountId } from "./codecs.js";
import { DocksideError, fail } from "./errors.js";
import { codec } from "./schemas.js";

/**
 * Runtime configuration from environment variables. Fails closed: unknown DOCKSIDE_*
 * variables (typos) and invalid values stop startup. Values are never echoed in errors.
 */
const MS_DAY = 24 * 3600 * 1000;

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

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
    /**
     * Seed file of the deployment's dedicated audit-export signing key (M17, ADR-0018), created by
     * `pnpm run export-key generate`. Read only by the isolated signer child process; never by the API.
     */
    DOCKSIDE_AUDIT_EXPORT_KEY_FILE: z.string().min(1).optional(),
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
    /* ---------------- real-chain runtime (M43, docs/runbooks/testnet-product.md) ---------------- */
    /**
     * Build manifest (`contract.nearCodeHash`) or artifact record (`nearCodeHash`) of the deployed
     * escrow. Required whenever the API or worker talks to a NEAR node: startup refuses unless the
     * escrow's on-chain code hash equals it.
     */
    DOCKSIDE_ESCROW_MANIFEST: z.string().min(1).optional(),
    /** `status.chain_id` the RPC node must report: `testnet`, or a local sandbox's id on a loopback RPC. */
    DOCKSIDE_NEAR_CHAIN_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .default("testnet"),
    /** Relayer account whose function-call key (restricted to the escrow) the worker signs with. */
    DOCKSIDE_RELAYER_ACCOUNT_ID: z
      .string()
      .transform(codec((s) => parseNearAccountId(s, {})))
      .optional(),
    /**
     * PATH of the relayer's near-cli-rs key file (never the key itself). Read only by the worker,
     * checked for owner-only permissions and kept out of every log and HTTP message.
     */
    DOCKSIDE_RELAYER_KEY_FILE: z.string().min(1).optional(),
    /** Loopback port of the worker's party-call relay (`/relay/v1/*`, proxied by the web server). */
    DOCKSIDE_RELAY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    /** Seed files of the ManifestAttestor and deterministic-policy service keys (isolated signer processes). */
    DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE: z.string().min(1).optional(),
    DOCKSIDE_POLICY_SERVICE_KEY_FILE: z.string().min(1).optional(),
    /** Transaction validity period of the chain in blocks (NEAR testnet: 86400). */
    DOCKSIDE_TX_VALIDITY_BLOCKS: z.coerce.number().int().min(10).max(1_000_000).default(86_400),
    DOCKSIDE_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
    /* ---------------- supplier cash-out through 1Click (M52, ADR-0027) ---------------- */
    /**
     * Origin of the NEAR Intents 1Click service the API asks for token lists, `dry: true` quotes and
     * statuses. Unset: the cash-out panel reports NOT_CONFIGURED. https, or http on a loopback host
     * (a local simulator).
     */
    DOCKSIDE_ONE_CLICK_URL: z
      .string()
      .url()
      .refine((u) => {
        const url = new URL(u);
        return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
      }, "1Click endpoint must be https, or http on a loopback host")
      .refine((u) => new URL(u).origin === u, "1Click endpoint must be an origin without a path")
      .optional(),
    /**
     * PATH of a file holding the optional 1Click partner token (never the token itself). Read once at
     * startup, sent as a bearer header on the read-only requests, kept out of every log and answer.
     */
    DOCKSIDE_ONE_CLICK_TOKEN_FILE: z.string().min(1).optional(),
    /**
     * NEAR network the configured 1Click service settles on. The public service is mainnet only;
     * `near-testnet` is accepted only together with a loopback DOCKSIDE_ONE_CLICK_URL (a simulator).
     */
    DOCKSIDE_ONE_CLICK_NEAR_NETWORK: z.enum(NETWORKS).default("near-mainnet"),
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
  const oneClick = r.data.DOCKSIDE_ONE_CLICK_URL;
  if (oneClick === undefined && r.data.DOCKSIDE_ONE_CLICK_TOKEN_FILE !== undefined)
    throw new DocksideError("CONFIG_INVALID", "invalid configuration value", {
      name: "DOCKSIDE_ONE_CLICK_TOKEN_FILE",
    });
  if (
    r.data.DOCKSIDE_ONE_CLICK_NEAR_NETWORK !== "near-mainnet" &&
    (oneClick === undefined || !isLoopback(new URL(oneClick).hostname))
  )
    fail("CONFIG_INVALID", "a 1Click service off mainnet is accepted only on a loopback endpoint", {
      name: "DOCKSIDE_ONE_CLICK_NEAR_NETWORK",
    });
  return Object.freeze(r.data);
}

/** Names of configuration keys that hold secrets; redacted from any diagnostic output. */
export const SECRET_CONFIG_KEYS: readonly string[] = [];

export function redactConfig(c: DocksideConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) out[k] = SECRET_CONFIG_KEYS.includes(k) ? "[REDACTED]" : v;
  return out;
}
