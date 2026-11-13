import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createFront } from "./front.js";
import { type HostedProfile, resolveHostedProfile } from "./profile.js";

/**
 * Hosted launcher (M55, ADR-0027): the single process a container host runs. It starts the real
 * control API (`services/api/dist/main.js`) and the real worker (`services/worker/dist/main.js`)
 * with the M43 testnet runtime profile, both on loopback, and then opens the one public listener
 * that serves the web build and forwards `/v1`, `/healthz`, `/readyz` and `/relay`.
 *
 * Fail-closed, like the processes it starts: a refused configuration, a failed chain preflight, a
 * missing or unsuitable relayer key, or a child that exits at any time ends the whole container
 * with that child's exit status (78 for a refusal), and the host restarts or reports it. The public
 * port opens only after the API is listening and the worker has passed every custody check.
 *
 * The launcher holds no key. The relayer key file is prepared by the entrypoint from the host's
 * secret store and only its path is passed on, to the worker alone. The service key seeds live on
 * the persistent volume, are created here on first start through the existing custody tools, and
 * are read only by the isolated signer processes.
 */

const APP_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPTS = {
  api: join(APP_ROOT, "services/api/dist/main.js"),
  worker: join(APP_ROOT, "services/worker/dist/main.js"),
  serviceKey: join(APP_ROOT, "services/api/dist/cli/service-key.js"),
  exportKey: join(APP_ROOT, "services/api/dist/cli/export-key.js"),
};

const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

class Refusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** The persistent volume must exist and be writable by this user before anything starts. */
function prepareDataDir(p: HostedProfile): void {
  try {
    mkdirSync(join(p.dataDir, "keys"), { recursive: true, mode: 0o700 });
    mkdirSync(join(p.dataDir, "objects"), { recursive: true, mode: 0o700 });
    chmodSync(join(p.dataDir, "keys"), 0o700);
    accessSync(p.dataDir, constants.W_OK);
  } catch {
    throw new Refusal("DATA_DIR_NOT_WRITABLE", "the data directory is missing or not writable by this user");
  }
}

/**
 * First start on a fresh volume: create the service key seeds with the custody tools of M17 and
 * M43 (exclusive create, owner-only). Later starts find them and create nothing. Only public keys
 * are logged.
 */
function ensureServiceKeys(p: HostedProfile): void {
  const wanted: [name: string, file: string, args: string[]][] = [
    ["audit-export", p.keyFiles.auditExport, [SCRIPTS.exportKey, "generate"]],
    [
      "manifest-attestor",
      p.keyFiles.manifestAttestor,
      [SCRIPTS.serviceKey, "generate", "--capability", "MANIFEST_ATTEST"],
    ],
    [
      "deterministic-policy",
      p.keyFiles.deterministicPolicy,
      [SCRIPTS.serviceKey, "generate", "--capability", "DETERMINISTIC_POLICY_SET"],
    ],
  ];
  for (const [name, file, args] of wanted) {
    if (existsSync(file)) continue;
    const r = spawnSync(process.execPath, [...args, "--out", file], {
      encoding: "utf8",
      env: {
        ...(process.env["PATH"] === undefined ? {} : { PATH: process.env["PATH"] }),
        ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }),
      },
    });
    if (r.status !== 0) throw new Refusal("SERVICE_KEY_NOT_CREATED", `could not create the ${name} key`);
    const publicKey = (JSON.parse(r.stdout) as { publicKey: string }).publicKey;
    log({ event: "hosted.key_created", key: name, publicKey });
  }
}

interface Child {
  readonly name: string;
  readonly proc: ChildProcess;
  readonly ready: Promise<void>;
}

/** Start a child, pass its output through unchanged, and resolve once it reports `readyEvent`. */
function start(
  name: string,
  script: string,
  env: Readonly<Record<string, string>>,
  readyEvent: string,
  timeoutMs: number,
  onExit: (name: string, code: number | null) => void,
): Child {
  const proc = spawn(process.execPath, [script], { env: { ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let settle: { ok: () => void; fail: (e: Error) => void } | null = null;
  const ready = new Promise<void>((ok, fail) => {
    settle = { ok, fail };
  });
  const timer = setTimeout(
    () => settle?.fail(new Refusal("CHILD_NOT_READY", `${name} did not become ready in time`)),
    timeoutMs,
  );
  createInterface({ input: proc.stdout as NodeJS.ReadableStream }).on("line", (line) => {
    process.stdout.write(`${line}\n`);
    if (line.includes(`"event":"${readyEvent}"`)) {
      clearTimeout(timer);
      settle?.ok();
    }
  });
  createInterface({ input: proc.stderr as NodeJS.ReadableStream }).on("line", (line) => {
    process.stderr.write(`${line}\n`);
  });
  proc.on("exit", (code) => {
    clearTimeout(timer);
    settle?.fail(new Refusal("CHILD_EXITED", `${name} exited before it was ready`));
    onExit(name, code);
  });
  return { name, proc, ready };
}

async function main(): Promise<void> {
  let profile: HostedProfile;
  try {
    profile = resolveHostedProfile(process.env, { appRoot: APP_ROOT });
    prepareDataDir(profile);
    ensureServiceKeys(profile);
  } catch (e) {
    const err = e as { code?: string; reason?: string; message?: string; details?: Record<string, unknown> };
    // A code, a reason and a variable name; never a value.
    log({
      event: "hosted.refused",
      code: err.code ?? (err.reason ? "HOSTED_REFUSED" : "INTERNAL"),
      reason: err.reason ?? null,
      message: err.message ?? null,
      ...(err.details ?? {}),
    });
    process.exit(78);
  }

  const children: Child[] = [];
  let front: Server | null = null;
  let stopping = false;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    front?.close();
    front?.closeAllConnections();
    const alive = children.filter((c) => c.proc.exitCode === null && c.proc.signalCode === null);
    if (alive.length === 0) process.exit(code);
    let left = alive.length;
    for (const c of alive) {
      c.proc.once("exit", () => {
        left -= 1;
        if (left === 0) process.exit(code);
      });
      c.proc.kill("SIGTERM");
    }
    setTimeout(() => {
      for (const c of alive) c.proc.kill("SIGKILL");
      process.exit(code);
    }, 10_000).unref();
  };
  const onExit = (name: string, code: number | null) => {
    if (stopping) return;
    log({ event: "hosted.child_exited", child: name, exitCode: code });
    shutdown(code === null || code === 0 ? 1 : code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  try {
    const api = start("api", SCRIPTS.api, profile.apiEnv, "listening", 90_000, onExit);
    children.push(api);
    await api.ready;
    const worker = start("worker", SCRIPTS.worker, profile.workerEnv, "worker.started", 180_000, onExit);
    children.push(worker);
    await worker.ready;
    const server = createFront({
      webRoot: profile.webRoot,
      proofRoot: profile.proofRoot,
      origin: profile.origin,
      apiPort: profile.apiPort,
      relayPort: profile.relayPort,
    });
    front = server;
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(profile.listen.port, profile.listen.host, ok);
    });
    // Non-secret facts the operator's tools (the demo seed) need to reach this deployment.
    writeFileSync(
      join(profile.dataDir, "hosted-runtime.json"),
      `${JSON.stringify(
        {
          origin: profile.origin,
          apiPort: profile.apiPort,
          manifestAttestorKeyFile: profile.keyFiles.manifestAttestor,
          deterministicPolicyKeyFile: profile.keyFiles.deterministicPolicy,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    log({
      event: "hosted.started",
      origin: profile.origin,
      listen: profile.listen,
      dataDir: profile.dataDir,
      escrow: profile.apiEnv["DOCKSIDE_ESCROW_CONTRACT_ID"],
      chainId: profile.apiEnv["DOCKSIDE_NEAR_CHAIN_ID"],
    });
  } catch (e) {
    if (stopping) return;
    log({
      event: "hosted.refused",
      code: "HOSTED_REFUSED",
      reason: (e as { reason?: string }).reason ?? "START_FAILED",
      message: (e as Error).message,
    });
    shutdown(1);
  }
}

void main();
