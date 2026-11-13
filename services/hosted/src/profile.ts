import { join } from "node:path";
import { DocksideError, loadConfig } from "@dockside/core";

/**
 * Hosted runtime profile (M55, ADR-0027): turns the environment a container host provides
 * (Render, Fly.io, or a plain `docker run`) into the M43 testnet runtime profile of the API and the
 * worker. The launcher owns every path and loopback port; the operator supplies the chain profile
 * and the public origin. Children receive an explicit environment built here, so a host secret or
 * any other variable of the container never reaches them. Errors name a variable, never a value.
 */

export interface HostedProfile {
  /** The one public listener (plain HTTP; the host terminates TLS). */
  readonly listen: { readonly host: string; readonly port: number };
  /** Public origin of the deployment, bound into every proof (DOCKSIDE_ORIGIN). */
  readonly origin: string;
  /** Persistent volume: database, evidence objects, service key seeds. */
  readonly dataDir: string;
  /** Directory of the production web build. */
  readonly webRoot: string;
  readonly apiPort: number;
  readonly relayPort: number;
  readonly keyFiles: {
    readonly auditExport: string;
    readonly manifestAttestor: string;
    readonly deterministicPolicy: string;
  };
  /** Private copy of the relayer's function-call key file, or null when the host supplied none. */
  readonly relayerKeyFile: string | null;
  readonly apiEnv: Readonly<Record<string, string>>;
  readonly workerEnv: Readonly<Record<string, string>>;
  /** The proof site (site/proof) served under /proof/, with the attack console at /proof/attack/. */
  readonly proofRoot: string;
  /** Loopback port of the attack relay (M53). */
  readonly attackPort: number;
  /** Environment of the attack relay process: its own settings only, never the API's or worker's. */
  readonly attackEnv: Readonly<Record<string, string>>;
}

/** DOCKSIDE_* settings the launcher derives itself; setting one by hand is refused. */
export const LAUNCHER_OWNED: readonly string[] = [
  "DOCKSIDE_DB_PATH",
  "DOCKSIDE_OBJECT_STORE_DIR",
  "DOCKSIDE_HOST",
  "DOCKSIDE_PORT",
  "DOCKSIDE_RELAY_PORT",
  "DOCKSIDE_RELAYER_KEY_FILE",
  "DOCKSIDE_AUDIT_EXPORT_KEY_FILE",
  "DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE",
  "DOCKSIDE_POLICY_SERVICE_KEY_FILE",
];

/** Settings only the worker receives. */
const WORKER_ONLY: readonly string[] = [
  "DOCKSIDE_RELAYER_ACCOUNT_ID",
  "DOCKSIDE_TX_VALIDITY_BLOCKS",
  "DOCKSIDE_WORKER_INTERVAL_MS",
];

/** A hosted deployment always talks to a chain, so these have no default. */
const REQUIRED: readonly string[] = [
  "DOCKSIDE_ESCROW_CONTRACT_ID",
  "DOCKSIDE_NEAR_RPC_URL",
  "DOCKSIDE_RELAYER_ACCOUNT_ID",
  "DOCKSIDE_ESCROW_MANIFEST",
];

function refuse(name: string, message: string): never {
  throw new DocksideError("CONFIG_INVALID", message, { name });
}

function port(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,5}$/.test(raw)) refuse(name, "port must be a number between 1 and 65535");
  const n = Number(raw);
  if (n < 1 || n > 65535) refuse(name, "port must be a number between 1 and 65535");
  return n;
}

/** The public origin: explicit, or the one the host announces for its own HTTPS endpoint. */
function publicOrigin(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env["DOCKSIDE_ORIGIN"];
  if (explicit !== undefined && explicit !== "") return explicit;
  const render = env["RENDER_EXTERNAL_URL"];
  if (render !== undefined && render !== "") return render.replace(/\/$/, "");
  const fly = env["FLY_APP_NAME"];
  if (fly !== undefined && /^[a-z0-9][a-z0-9-]{0,62}$/.test(fly)) return `https://${fly}.fly.dev`;
  return refuse("DOCKSIDE_ORIGIN", "the public HTTPS origin of the deployment is required");
}

export function resolveHostedProfile(
  env: Readonly<Record<string, string | undefined>>,
  opts: { readonly appRoot: string },
): HostedProfile {
  for (const name of LAUNCHER_OWNED)
    if (env[name] !== undefined) refuse(name, "this setting is derived by the hosted launcher; remove it");
  for (const name of REQUIRED)
    if (env[name] === undefined || env[name] === "")
      refuse(name, "required for the hosted testnet runtime profile");

  const listen = { host: env["HOSTED_BIND"] || "0.0.0.0", port: port(env, "PORT", 8080) };
  const apiPort = port(env, "HOSTED_API_PORT", 8787);
  const relayPort = port(env, "HOSTED_RELAY_PORT", 8788);
  const attackPort = port(env, "HOSTED_ATTACK_PORT", 8789);
  if (relayPort === apiPort) refuse("HOSTED_RELAY_PORT", "the relay and the API need different ports");
  if (apiPort === listen.port)
    refuse("HOSTED_API_PORT", "the API and the public listener need different ports");
  if (relayPort === listen.port)
    refuse("HOSTED_RELAY_PORT", "the relay and the public listener need different ports");
  if (new Set([apiPort, relayPort, attackPort, listen.port]).size !== 4)
    refuse("HOSTED_ATTACK_PORT", "the attack relay needs its own port");

  const origin = publicOrigin(env);
  const dataDir = env["HOSTED_DATA_DIR"] || "/data";
  const keyFiles = {
    auditExport: join(dataDir, "keys", "audit-export.seed"),
    manifestAttestor: join(dataDir, "keys", "manifest-attestor.seed"),
    deterministicPolicy: join(dataDir, "keys", "deterministic-policy.seed"),
  };
  const relayerKeyFile = env["HOSTED_RELAYER_KEY_FILE"] || null;

  // Operator-supplied DOCKSIDE_* settings; unknown names are caught by loadConfig below.
  const operator: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (k.startsWith("DOCKSIDE_") && v !== undefined && k !== "DOCKSIDE_ORIGIN") operator[k] = v;
  const shared: Record<string, string> = {
    ...(env["PATH"] === undefined ? {} : { PATH: env["PATH"] }),
    // Node on Windows needs SystemRoot for sockets; it is absent on the Linux image.
    ...(env["SystemRoot"] === undefined ? {} : { SystemRoot: env["SystemRoot"] }),
    NODE_ENV: "production",
    NODE_NO_WARNINGS: "1",
    DOCKSIDE_NETWORK: "near-testnet",
    DOCKSIDE_NEAR_CHAIN_ID: "testnet",
    DOCKSIDE_ORIGIN: origin,
    DOCKSIDE_DB_PATH: join(dataDir, "dockside.sqlite"),
    DOCKSIDE_OBJECT_STORE_DIR: join(dataDir, "objects"),
  };
  for (const [k, v] of Object.entries(operator)) if (!WORKER_ONLY.includes(k)) shared[k] = v;

  const apiEnv: Record<string, string> = {
    ...shared,
    DOCKSIDE_HOST: "127.0.0.1",
    DOCKSIDE_PORT: String(apiPort),
    DOCKSIDE_AUDIT_EXPORT_KEY_FILE: keyFiles.auditExport,
  };
  const workerEnv: Record<string, string> = {
    ...shared,
    DOCKSIDE_RELAY_PORT: String(relayPort),
    DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE: keyFiles.manifestAttestor,
    DOCKSIDE_POLICY_SERVICE_KEY_FILE: keyFiles.deterministicPolicy,
    ...(relayerKeyFile === null ? {} : { DOCKSIDE_RELAYER_KEY_FILE: relayerKeyFile }),
  };
  for (const k of WORKER_ONLY) {
    const v = operator[k];
    if (v !== undefined) workerEnv[k] = v;
  }

  // The same validation the processes run at startup, so a bad value is refused before anything
  // is created. loadConfig reports the variable's name only.
  loadConfig(apiEnv);
  loadConfig(workerEnv);

  const proofRoot = env["HOSTED_PROOF_ROOT"] || join(opts.appRoot, "site", "proof");
  const allowed = env["HOSTED_ATTACK_ALLOWED_ORIGINS"] ?? "";
  for (const o of allowed
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean))
    if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(o))
      refuse("HOSTED_ATTACK_ALLOWED_ORIGINS", "list https origins separated by commas");
  const attackEnv: Record<string, string> = {
    ...(env["PATH"] === undefined ? {} : { PATH: env["PATH"] }),
    ...(env["SystemRoot"] === undefined ? {} : { SystemRoot: env["SystemRoot"] }),
    NODE_ENV: "production",
    NODE_NO_WARNINGS: "1",
    HOSTED_ATTACK_PORT: String(attackPort),
    HOSTED_ATTACK_CONFIG: env["HOSTED_ATTACK_CONFIG"] || join(proofRoot, "attack", "attack-demo.json"),
    HOSTED_ATTACK_LOG: join(dataDir, "attack-attempts.jsonl"),
    HOSTED_ATTACK_ALLOWED_ORIGINS: allowed,
    DOCKSIDE_NEAR_RPC_URL: String(env["DOCKSIDE_NEAR_RPC_URL"]),
    ...(env["HOSTED_ATTACK_KEY_FILE"] ? { HOSTED_ATTACK_KEY_FILE: env["HOSTED_ATTACK_KEY_FILE"] } : {}),
  };

  return Object.freeze({
    listen,
    origin,
    dataDir,
    webRoot: env["HOSTED_WEB_ROOT"] || join(opts.appRoot, "apps", "web", "dist"),
    apiPort,
    relayPort,
    keyFiles,
    relayerKeyFile,
    apiEnv: Object.freeze(apiEnv),
    workerEnv: Object.freeze(workerEnv),
    proofRoot,
    attackPort,
    attackEnv: Object.freeze(attackEnv),
  });
}
