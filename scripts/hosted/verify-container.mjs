// Container verification of the hosted image (M55): builds the image from the Dockerfile, starts a
// LOCAL nearcore sandbox prepared like the testnet deployment (scripts/near-sandbox/product-chain.mjs:
// the reproducible escrow wasm deployed and initialised, a relayer function-call key restricted to
// the escrow), runs the image against it and checks, from outside the container, that it serves the
// web app, the API health endpoints and the relay, refuses to start without a suitable relayer key,
// seeds the demo organisations through the real API, and keeps its state across a restart.
//
// Local only: no testnet, no mainnet, nothing published. Needs Docker (inside WSL on Windows;
// DOCKSIDE_DOCKER overrides the command), `pnpm run build` and `.data/repro` (pnpm run
// contract:reproduce). Ports: DOCKSIDE_HOSTED_VERIFY_PORT_BASE (default 9031) and the next three.
//
//   node scripts/hosted/verify-container.mjs [--no-build] [--keep]
//
// Exit status 0 when every check passed. The result is written to .data/hosted/container-run.json.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestHexFor,
  fromTypedJson,
  generateEd25519KeyPair,
  newNonce,
  sha256,
  signFor,
  toHex,
} from "../../packages/core/dist/index.js";
import { hostPath } from "../lib/docker.mjs";
import { prepareProductChain, startSandbox } from "../near-sandbox/product-chain.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = new Set(process.argv.slice(2));
const BASE = Number(process.env.DOCKSIDE_HOSTED_VERIFY_PORT_BASE ?? 9031);
const PORTS = { rpc: BASE, web: BASE + 1, api: BASE + 2, relay: BASE + 3 };
const IMAGE = "dockside-hosted:m55-verify";
const APP = "dockside-m55-verify-app";
const SANDBOX = "dockside-m55-verify-sandbox";
const VOLUME = "dockside-m55-verify-data";
const WEB = `http://127.0.0.1:${PORTS.web}`;

const dockerCmd = (
  process.env.DOCKSIDE_DOCKER ||
  (process.platform === "win32" ? "wsl.exe -d Ubuntu-24.04 -u root -- docker" : "docker")
)
  .split(" ")
  .filter(Boolean);
function docker(argv, timeout = 120_000) {
  const r = spawnSync(dockerCmd[0], [...dockerCmd.slice(1), ...argv], {
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const enginePath = (p) => hostPath(p, dockerCmd);

const checks = [];
function check(name, ok, detail = undefined) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  ${JSON.stringify(detail)}`}\n`,
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });

/** `docker run` arguments of the product container; `secret` selects how the relayer key arrives. */
function runArgs(chain, sb, { name, volume, secret, detached }) {
  const manifestDir = enginePath(join(ROOT, ".data/repro"));
  const out = [
    "run",
    ...(detached ? ["-d"] : ["--rm"]),
    "--name",
    name,
    // The container shares the engine host's loopback, where the sandbox RPC is published: the
    // product only accepts a plain-HTTP RPC on a loopback address.
    "--network",
    "host",
    "-v",
    `${volume}:/data`,
    "-v",
    `${manifestDir}:/manifest:ro`,
    "-e",
    `PORT=${PORTS.web}`,
    "-e",
    `HOSTED_API_PORT=${PORTS.api}`,
    "-e",
    `HOSTED_RELAY_PORT=${PORTS.relay}`,
    "-e",
    `DOCKSIDE_ORIGIN=${WEB}`,
    "-e",
    `DOCKSIDE_ESCROW_CONTRACT_ID=${chain.accounts.escrow}`,
    "-e",
    `DOCKSIDE_NEAR_RPC_URL=http://127.0.0.1:${PORTS.rpc}`,
    "-e",
    `DOCKSIDE_NEAR_CHAIN_ID=${sb.chainId}`,
    "-e",
    `DOCKSIDE_RELAYER_ACCOUNT_ID=${chain.accounts.relayer}`,
    "-e",
    "DOCKSIDE_ESCROW_MANIFEST=/manifest/build-manifest.json",
    "-e",
    "DOCKSIDE_WORKER_INTERVAL_MS=1000",
  ];
  if (secret?.file) out.push("-v", `${enginePath(secret.file)}:/etc/secrets/relayer-key.json:ro`);
  if (secret?.base64) out.push("-e", `RELAYER_KEY_JSON_B64=${secret.base64}`);
  out.push(IMAGE);
  return out;
}

async function waitReady(name) {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      const r = await fetch(`${WEB}/readyz`);
      if (r.ok) return true;
    } catch {
      // not listening yet
    }
    const alive = docker(["ps", "-q", "-f", `name=^${name}$`]);
    if (alive.stdout.trim() === "") return false;
    if (Date.now() > deadline) return false;
    await sleep(1500);
  }
}

/** A person on their own device, outside the container: own key, public URL, request proofs. */
class Person {
  constructor() {
    this.key = generateEd25519KeyPair();
    this.grant = null;
  }
  async post(path, body, headers = {}) {
    const res = await fetch(`${WEB}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB, ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }
  async accept(secret, displayName) {
    const ch = await this.post("/v1/invitations/challenges", {
      invitationSecret: secret,
      publicKey: this.key.publicKey,
      displayName,
    });
    if (ch.status !== 201) return ch;
    const payload = fromTypedJson(ch.json.payload);
    if (digestHexFor("POP_CHALLENGE", payload) !== ch.json.digestHex) throw new Error("digest mismatch");
    const done = await this.post("/v1/invitations/accept", {
      challengeId: ch.json.challengeId,
      proof: {
        scheme: "dockside-ed25519",
        signature: signFor(this.key.privateKey, "POP_CHALLENGE", payload),
      },
    });
    if (done.status === 201) this.grant = done.json;
    return done;
  }
  async me() {
    const issuedAt = Date.now();
    const nonce = newNonce();
    const payload = {
      sessionId: this.grant.sessionId,
      origin: WEB,
      method: "GET",
      path: "/v1/me",
      bodyDigest: toHex(sha256(new Uint8Array(0))),
      issuedAt,
      nonce,
    };
    const proof = {
      sessionId: this.grant.sessionId,
      issuedAt,
      nonce,
      signature: signFor(this.key.privateKey, "REQUEST_PROOF", payload),
    };
    const res = await fetch(`${WEB}/v1/me`, {
      headers: {
        authorization: `Dockside-Session ${this.grant.sessionToken}`,
        "dockside-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
      },
    });
    return { status: res.status, json: await res.json() };
  }
}

function seed(...cmd) {
  const r = docker(["exec", APP, "/app/deploy/entrypoint.sh", "seed-demo", ...cmd]);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // reported by the caller
  }
  return { status: r.status, json, stderr: r.stderr.trim() };
}

async function main() {
  const wasm = join(ROOT, ".data/repro/dockside_escrow.wasm");
  const manifestFile = join(ROOT, ".data/repro/build-manifest.json");
  if (!existsSync(wasm) || !existsSync(manifestFile))
    throw new Error(".data/repro is missing: run `pnpm run contract:reproduce` first");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const expectedHash = manifest.contract?.nearCodeHash ?? manifest.nearCodeHash;
  const started = Date.now();

  if (!args.has("--no-build")) {
    process.stdout.write("building the image...\n");
    const b = docker(["build", "-t", IMAGE, enginePath(ROOT)], 1_200_000);
    check(
      "the image builds from the Dockerfile",
      b.status === 0,
      b.status === 0 ? undefined : (b.stdout + b.stderr).slice(-2000),
    );
    if (b.status !== 0) return;
  }
  const imageId = docker(["image", "inspect", "-f", "{{.Id}}", IMAGE]).stdout.trim();
  const imageSize = Number(docker(["image", "inspect", "-f", "{{.Size}}", IMAGE]).stdout.trim());

  // ---- the image carries no key and declares a non-root runtime user for the product ----
  const scan = docker([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    'echo ==FILES; find / -xdev \\( -name "*.seed" -o -name "*.pem" -o -name ".env*" -o -name "*credentials*" \\) -not -path "/proc/*" -not -path "/usr/share/*" -not -path "/usr/local/lib/node_modules/*" -not -path "/etc/ssl/*"; echo ==KEYS; grep -rlE "private_key|secret_key" /app --include=*.json; echo ==DATA; ls -A /data; echo ==TOOLS; ls -d /app/node_modules/vite /app/node_modules/typescript /app/node_modules/.pnpm/vite@* /app/node_modules/.pnpm/typescript@* /app/packages/core/src 2>/dev/null; echo ==END',
  ]);
  const scanLines = scan.stdout.split(/\r?\n/).filter(Boolean);
  check(
    "the image contains no key file, no seed, no .env, no sources and no development tools",
    scanLines.join(" ") === "==FILES ==KEYS ==DATA ==TOOLS ==END",
    scanLines,
  );

  const dir = mkdtempSync(join(tmpdir(), "dockside-m55-verify-"));
  docker(["rm", "-f", APP]);
  docker(["volume", "rm", "-f", VOLUME]);
  docker(["volume", "rm", "-f", `${VOLUME}-refusal`]);
  process.stdout.write("starting the local nearcore sandbox...\n");
  const sb = await startSandbox({ name: SANDBOX, port: PORTS.rpc });
  const evidence = { checks, image: { id: imageId, sizeBytes: imageSize } };
  try {
    const chain = await prepareProductChain(sb, { wasm, dir });
    evidence.chain = {
      kind: "local nearcore sandbox (not testnet, not mainnet)",
      chainId: sb.chainId,
      accounts: chain.accounts,
      escrowCodeHash: expectedHash,
      setupTransactions: chain.txs,
      relayerFunctionCallPublicKey: chain.relayerFcPublicKey,
    };

    // ---- fail closed: no relayer key, then a full-access key ----
    const none = docker(runArgs(chain, sb, { name: `${APP}-refusal`, volume: `${VOLUME}-refusal` }), 300_000);
    const noneEvents = events(none.stdout);
    check(
      "without a relayer key from the host the container exits 78 (RELAYER_SIGNER_NOT_PROVISIONED)",
      none.status === 78 &&
        noneEvents.some(
          (e) => e.event === "worker.blocked" && e.reason === "RELAYER_SIGNER_NOT_PROVISIONED",
        ) &&
        !noneEvents.some((e) => e.event === "hosted.started"),
      { exit: none.status },
    );
    const full = docker(
      runArgs(chain, sb, {
        name: `${APP}-refusal`,
        volume: `${VOLUME}-refusal`,
        secret: { file: chain.relayerFullKeyFile },
      }),
      300_000,
    );
    const fullEvents = events(full.stdout);
    check(
      "with a full-access relayer key the container exits 78 (FULL_ACCESS_KEY)",
      full.status === 78 &&
        fullEvents.some((e) => e.event === "worker.refused" && e.reason === "FULL_ACCESS_KEY") &&
        !fullEvents.some((e) => e.event === "hosted.started"),
      { exit: full.status, refusal: fullEvents.find((e) => e.event === "worker.refused") ?? null },
    );
    docker(["volume", "rm", "-f", `${VOLUME}-refusal`]);

    // ---- first start on a fresh volume, relayer key as a mounted secret file ----
    const run = docker(
      runArgs(chain, sb, {
        name: APP,
        volume: VOLUME,
        secret: { file: chain.relayerKeyFile },
        detached: true,
      }),
    );
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    const up = await waitReady(APP);
    const logs1 = docker(["logs", APP]);
    const ev1 = events(logs1.stdout);
    check(
      "the container starts and becomes ready",
      up,
      up ? undefined : (logs1.stdout + logs1.stderr).slice(-3000),
    );
    if (!up) return;

    const listening = ev1.find((e) => e.event === "listening");
    const workerStarted = ev1.find((e) => e.event === "worker.started");
    check(
      "the API passed the chain preflight against the sandbox escrow (code hash equals the manifest)",
      listening?.chain?.chainId === sb.chainId &&
        listening?.chain?.escrow === chain.accounts.escrow &&
        listening?.chain?.codeHash === expectedHash &&
        listening?.tradeModules === "CONFIGURED",
      listening?.chain,
    );
    check(
      "the worker passed the custody checks: nearcore confirms the function-call key restricted to the escrow",
      workerStarted?.relayerPublicKey === chain.relayerFcPublicKey &&
        workerStarted?.relayer === chain.accounts.relayer &&
        workerStarted?.codeHash === expectedHash &&
        workerStarted?.services?.manifestAttestor === true &&
        workerStarted?.services?.deterministicPolicy === true,
      workerStarted,
    );
    const createdKeys = ev1.filter((e) => e.event === "hosted.key_created").map((e) => e.key);
    check(
      "first start created the three service keys on the volume",
      JSON.stringify(createdKeys) ===
        JSON.stringify(["audit-export", "manifest-attestor", "deterministic-policy"]),
      createdKeys,
    );

    const health = await fetch(`${WEB}/healthz`);
    check(
      "GET /healthz answers 200 {status: ok}",
      health.status === 200 && (await health.json()).status === "ok",
    );
    const ready = await (await fetch(`${WEB}/readyz`)).json();
    check(
      "GET /readyz reports the migrated database, near-testnet rules and funded payouts BLOCKED",
      ready.ready === true &&
        ready.network === "near-testnet" &&
        ready.fundedPayouts === "BLOCKED" &&
        ready.schemaVersion > 0,
      ready,
    );
    const page = await fetch(`${WEB}/`);
    const html = await page.text();
    check(
      "GET / serves the web app with the strict content security policy",
      page.status === 200 &&
        html.includes('id="root"') &&
        (page.headers.get("content-security-policy") ?? "").includes("default-src 'none'") &&
        page.headers.get("x-frame-options") === "DENY",
    );
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    let assetsOk = assets.length >= 2;
    for (const a of assets) {
      const r = await fetch(`${WEB}${a}`);
      const body = await r.arrayBuffer();
      assetsOk &&=
        r.status === 200 && body.byteLength > 0 && /javascript|css/.test(r.headers.get("content-type") ?? "");
    }
    check("every script and stylesheet the page names is served", assetsOk, assets);
    const deep = await fetch(`${WEB}/sign-in`);
    check(
      "an application route (/sign-in) gets the app shell",
      deep.status === 200 && (await deep.text()).includes('id="root"'),
    );
    const relay = await fetch(`${WEB}/relay/v1/status`);
    const relayJson = await relay.json();
    check(
      "GET /relay/v1/status reaches the worker's relay (relayer and escrow of this deployment)",
      relay.status === 200 &&
        relayJson.relayer === chain.accounts.relayer &&
        relayJson.contractId === chain.accounts.escrow,
      relayJson,
    );
    const fund = await fetch(`${WEB}/relay/v1/calls`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB },
      body: JSON.stringify({
        call: {
          receiverId: chain.accounts.escrow,
          methodName: "fund",
          args: {},
          gas: "30000000000000",
          depositYocto: "1",
        },
      }),
    });
    const fundJson = await fund.json();
    check(
      "the relay refuses to send the buyer deposit (fund): the answer through the front is its 403",
      fund.status === 403 && String(fundJson.error).startsWith("FORBIDDEN"),
      { status: fund.status, error: fundJson.error },
    );
    const anon = await fetch(`${WEB}/v1/me`);
    check("an unauthenticated API call is refused by the API (401)", anon.status === 401);

    // ---- processes and the key inside the running container ----
    const top = docker(["top", APP, "-eo", "pid,uid,args"]);
    const procs = top.stdout
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.includes("node"));
    check(
      "every Node.js process of the product runs as the unprivileged user (uid 10001)",
      procs.length >= 5 && procs.every((l) => l.trim().split(/\s+/)[1] === "10001"),
      procs.map((l) => l.trim().replace(/\s+/g, " ")),
    );
    const keyStat = docker([
      "exec",
      APP,
      "sh",
      "-c",
      'stat -c "%a %U" /run/dockside/relayer-key.json /run/dockside; ls /data/keys; ls -ld /data/keys | cut -c1-10; ls /data | grep -ci relayer',
    ]);
    const ks = keyStat.stdout.split(/\r?\n/).filter(Boolean);
    check(
      "the relayer key is an owner-only private copy outside the volume; service seeds are on the volume",
      ks[0] === "600 dockside" &&
        ks[1] === "700 dockside" &&
        ks.includes("audit-export.seed") &&
        ks.includes("manifest-attestor.seed") &&
        ks.includes("deterministic-policy.seed") &&
        ks.includes("drwx------") &&
        ks[ks.length - 1] === "0",
      ks,
    );
    const relayerSecret = JSON.parse(readFileSync(chain.relayerKeyFile, "utf8")).private_key;
    check(
      "no log line contains the relayer key",
      !(logs1.stdout + logs1.stderr).includes(relayerSecret.slice(8)),
    );

    // ---- demo seed through the real API, a person accepting from outside, and the grant ----
    const enroll = seed("enroll");
    check(
      "seed-demo enroll: three organisations, the evidence policy, two active services, four invitations",
      enroll.status === 0 &&
        enroll.json?.organizations?.length === 3 &&
        enroll.json.organizations.every((o) => o.created === true) &&
        enroll.json.policy?.created === true &&
        enroll.json.services?.every((s) => s.status === "ACTIVE") &&
        enroll.json.invitations?.length === 4 &&
        enroll.json.invitations.every((i) => typeof i.secret === "string"),
      enroll.status === 0 ? undefined : enroll.stderr,
    );
    const again = seed("enroll");
    check(
      "seed-demo enroll again creates nothing and shows no secret",
      again.status === 0 &&
        again.json?.organizations?.every((o) => o.created === false) &&
        again.json.policy?.created === false &&
        again.json.invitations?.every((i) => i.secret === undefined),
      again.status === 0 ? undefined : again.stderr,
    );
    const approver = new Person();
    const secret = enroll.json?.invitations?.find((i) => i.capability === "BUYER_APPROVER")?.secret;
    const accepted = await approver.accept(secret, "Verification buyer approver");
    check(
      "a person outside the container accepts an invitation with their own key through the public port",
      accepted.status === 201,
      {
        status: accepted.status,
      },
    );
    const grant = seed("grant");
    const granted = grant.json?.grants?.find((g) => g.capability === "BUYER_APPROVER");
    check(
      "seed-demo grant gives that person the invited role and reports the others as pending",
      grant.status === 0 &&
        granted?.state === "GRANTED" &&
        granted?.principalId === approver.grant?.principalId &&
        grant.json.grants.filter((g) => g.state === "PENDING").length === 3,
      grant.json?.grants ?? grant.stderr,
    );
    const me = await approver.me();
    check(
      "that person's own session now carries BUYER_APPROVER (proof-signed request through the front)",
      me.status === 200 && JSON.stringify(me.json.capabilities) === '["BUYER_APPROVER"]',
      me.json?.capabilities ?? me.json,
    );
    evidence.seed = {
      organizations: enroll.json?.organizations ?? null,
      policy: enroll.json?.policy ?? null,
      services: enroll.json?.services ?? null,
      invitations: (enroll.json?.invitations ?? []).map(({ secret: _s, ...rest }) => rest),
    };

    // ---- restart on the same volume; the relayer key now arrives as a secret variable ----
    const stop = docker(["stop", "-t", "30", APP], 90_000);
    const exit = docker(["inspect", "-f", "{{.State.ExitCode}}", APP]).stdout.trim();
    check("docker stop ends the container cleanly (exit 0)", stop.status === 0 && exit === "0", { exit });
    docker(["rm", "-f", APP]);
    const b64 = readFileSync(chain.relayerKeyFile).toString("base64");
    const run2 = docker(
      runArgs(chain, sb, { name: APP, volume: VOLUME, secret: { base64: b64 }, detached: true }),
    );
    if (run2.status !== 0) throw new Error(`docker run failed: ${run2.stderr}`);
    const up2 = await waitReady(APP);
    const logs2 = docker(["logs", APP]);
    const ev2 = events(logs2.stdout);
    check(
      "the container restarts on the same volume with the key supplied as a secret variable",
      up2,
      up2 ? undefined : (logs2.stdout + logs2.stderr).slice(-3000),
    );
    if (!up2) return;
    const listening2 = ev2.find((e) => e.event === "listening");
    check(
      "the restart reuses the service keys and the database (no key created, same audit-export key, no migration)",
      !ev2.some((e) => e.event === "hosted.key_created") &&
        listening2?.auditExportKey === listening?.auditExportKey &&
        Array.isArray(listening2?.migrationsApplied) &&
        listening2.migrationsApplied.length === 0,
      {
        auditExportKeySame: listening2?.auditExportKey === listening?.auditExportKey,
        migrationsApplied: listening2?.migrationsApplied,
      },
    );
    const environ = docker([
      "exec",
      APP,
      "sh",
      "-c",
      'for p in /proc/[0-9]*; do if grep -qa RELAYER_KEY_JSON_B64 "$p/environ" 2>/dev/null; then cat "$p/comm"; fi; done; echo SCANNED',
    ]);
    const holders = environ.stdout
      .split(/\r?\n/)
      .filter((l) => l && l !== "SCANNED" && l !== "sh" && l !== "grep");
    check(
      "no running process of the container has the secret variable in its environment",
      environ.stdout.includes("SCANNED") && holders.length === 0,
      holders,
    );
    check(
      "no log line contains the relayer key after the restart",
      !(logs2.stdout + logs2.stderr).includes(relayerSecret.slice(8)) &&
        !(logs2.stdout + logs2.stderr).includes(b64),
    );
    const status = seed("status");
    const buyer = status.json?.organizations?.find((o) => o.role === "buyer");
    check(
      "after the restart the organisations, the granted person and the services are still there",
      status.status === 0 &&
        status.json.organizations.map((o) => o.organizationId).join() ===
          enroll.json.organizations.map((o) => o.organizationId).join() &&
        buyer?.principals?.some(
          (p) => p.principalId === approver.grant?.principalId && p.capabilities.includes("BUYER_APPROVER"),
        ) &&
        buyer?.services?.every((s) => s.status === "ACTIVE") &&
        buyer?.services?.length === 2,
      status.status === 0 ? undefined : status.stderr,
    );
    const me2 = await approver.me();
    check("the person's session from before the restart still authenticates", me2.status === 200, {
      status: me2.status,
    });
  } finally {
    evidence.durationSeconds = Math.round((Date.now() - started) / 1000);
    evidence.passed = checks.length > 0 && checks.every((c) => c.ok);
    mkdirSync(join(ROOT, ".data/hosted"), { recursive: true });
    writeFileSync(join(ROOT, ".data/hosted/container-run.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    if (!args.has("--keep")) {
      docker(["rm", "-f", APP]);
      docker(["rm", "-f", `${APP}-refusal`]);
      docker(["volume", "rm", "-f", VOLUME]);
      docker(["volume", "rm", "-f", `${VOLUME}-refusal`]);
      sb.stop();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then(
  () => {
    const failed = checks.filter((c) => !c.ok);
    process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
    process.exit(checks.length > 0 && failed.length === 0 ? 0 : 1);
  },
  (e) => {
    process.stderr.write(`hosted verification failed: ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
