/**
 * Global setup of the real-chain product suite (M43): the testnet runtime profile — the real API
 * process (`services/api/dist/main.js`), the real worker process (`services/worker/dist/main.js`)
 * with the production relayer signer, party relay and service keys, and the production web build —
 * pointed at a LOCAL nearcore sandbox prepared exactly like the testnet deployment
 * (scripts/near-sandbox/product-chain.mjs): the reproducible escrow wasm deployed and initialised
 * in one transaction, a relayer function-call key restricted to the escrow in a near-cli-rs key
 * file, and funded buyer and supplier accounts. The only differences from the testnet profile are
 * the RPC URL, the chain id the preflight expects and the account names. No testnet transaction.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareProductChain, startSandbox } from "../../../scripts/near-sandbox/product-chain.mjs";

export const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const PORTS = {
  api: Number(process.env["DOCKSIDE_E2E_SBX_API_PORT"] ?? 8801),
  relay: Number(process.env["DOCKSIDE_E2E_SBX_RELAY_PORT"] ?? 8802),
  web: Number(process.env["DOCKSIDE_E2E_SBX_WEB_PORT"] ?? 4401),
  rpc: Number(process.env["DOCKSIDE_E2E_SBX_RPC_PORT"] ?? 4551),
};
export const WEB = `http://127.0.0.1:${PORTS.web}`;

export interface SandboxRuntimeInfo {
  readonly rpcUrl: string;
  readonly chainId: string;
  readonly accounts: { escrow: string; relayer: string; buyer: string; supplier: string };
  readonly setupTxs: Record<string, string>;
  readonly buyerKeyFile: string;
  readonly services: { attestor: string; policy: string };
  readonly serviceKeyFiles: { attestor: string; policy: string };
  readonly dir: string;
  readonly evidenceDir: string;
}

const children: ChildProcess[] = [];

function serviceKey(file: string, capability: string): string {
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "services/api/dist/cli/service-key.js"),
      "generate",
      "--capability",
      capability,
      "--out",
      file,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`service-key generate failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { publicKey: string }).publicKey;
}

/** Start a process and resolve once a stdout line matches; reject if it exits first. */
function startProcess(
  name: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  ready: (line: string) => boolean,
  logFile: string,
  shell = false,
): Promise<ChildProcess> {
  const p = spawn(cmd, args, { cwd: join(ROOT, "apps/web"), env, stdio: ["ignore", "pipe", "pipe"], shell });
  children.push(p);
  let buf = "";
  const log: string[] = [];
  const append = (d: Buffer) => {
    const s = d.toString("utf8");
    log.push(s);
    writeFileSync(logFile, log.join(""));
    return s;
  };
  p.stderr?.on("data", append);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} did not become ready: ${log.join("")}`)), 120_000);
    p.stdout?.on("data", (d: Buffer) => {
      buf += append(d);
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      if (lines.some(ready)) {
        clearTimeout(timer);
        res(p);
      }
    });
    p.on("exit", (c) => {
      clearTimeout(timer);
      rej(new Error(`${name} exited ${c}: ${log.join("")}`));
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const repro = join(ROOT, ".data/repro");
  const wasm = join(repro, "dockside_escrow.wasm");
  const manifest = join(repro, "build-manifest.json");
  if (!existsSync(wasm) || !existsSync(manifest))
    throw new Error(".data/repro is missing: run `pnpm run contract:reproduce` first (USER-NEXT-STEPS §1)");
  for (const f of ["services/api/dist/main.js", "services/worker/dist/main.js", "apps/web/dist/index.html"])
    if (!existsSync(join(ROOT, f)))
      throw new Error(`${f} is missing: run pnpm run build and vite build first`);

  // Private directory outside the repository: key files, database, objects.
  const dir = mkdtempSync(join(tmpdir(), "dockside-m43-product-"));
  const evidenceDir = join(ROOT, ".data/sandbox-product");
  mkdirSync(evidenceDir, { recursive: true });
  const sb = await startSandbox({ name: "dockside-m43-product-sandbox", port: PORTS.rpc });
  let ok = false;
  try {
    const chain = await prepareProductChain(sb, { wasm, dir });
    const attestorFile = join(dir, "manifest-attestor.seed");
    const policyFile = join(dir, "deterministic-policy.seed");
    const exportFile = join(dir, "audit-export.seed");
    const services = {
      attestor: serviceKey(attestorFile, "MANIFEST_ATTEST"),
      policy: serviceKey(policyFile, "DETERMINISTIC_POLICY_SET"),
    };
    const ex = spawnSync(
      process.execPath,
      [join(ROOT, "services/api/dist/cli/export-key.js"), "generate", "--out", exportFile],
      { encoding: "utf8" },
    );
    if (ex.status !== 0) throw new Error(`export-key generate failed: ${ex.stderr}`);

    // The testnet runtime profile (docs/runbooks/testnet-product.md) with the sandbox's RPC.
    const base: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"])
      if (process.env[k] !== undefined) base[k] = process.env[k];
    const profile = {
      ...base,
      NODE_NO_WARNINGS: "1",
      DOCKSIDE_DB_PATH: join(dir, "dockside.sqlite"),
      DOCKSIDE_OBJECT_STORE_DIR: join(dir, "objects"),
      DOCKSIDE_ORIGIN: WEB,
      DOCKSIDE_NETWORK: "near-testnet",
      DOCKSIDE_ESCROW_CONTRACT_ID: chain.accounts.escrow,
      DOCKSIDE_NEAR_RPC_URL: sb.rpcUrl,
      DOCKSIDE_NEAR_CHAIN_ID: sb.chainId,
      DOCKSIDE_ESCROW_MANIFEST: manifest,
    };
    await startProcess(
      "api",
      process.execPath,
      [join(ROOT, "services/api/dist/main.js")],
      {
        ...profile,
        DOCKSIDE_HOST: "127.0.0.1",
        DOCKSIDE_PORT: String(PORTS.api),
        DOCKSIDE_AUDIT_EXPORT_KEY_FILE: exportFile,
      },
      (l) => l.includes('"event":"listening"'),
      join(evidenceDir, "api.log"),
    );
    await startProcess(
      "worker",
      process.execPath,
      [join(ROOT, "services/worker/dist/main.js")],
      {
        ...profile,
        DOCKSIDE_RELAYER_ACCOUNT_ID: chain.accounts.relayer,
        DOCKSIDE_RELAYER_KEY_FILE: chain.relayerKeyFile,
        DOCKSIDE_RELAY_PORT: String(PORTS.relay),
        DOCKSIDE_MANIFEST_ATTESTOR_KEY_FILE: attestorFile,
        DOCKSIDE_POLICY_SERVICE_KEY_FILE: policyFile,
        DOCKSIDE_WORKER_INTERVAL_MS: "1000",
      },
      (l) => l.includes('"event":"worker.started"'),
      join(evidenceDir, "worker.log"),
    );
    await startProcess(
      "web",
      "pnpm",
      ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(PORTS.web)],
      {
        ...process.env,
        DOCKSIDE_API_URL: `http://127.0.0.1:${PORTS.api}`,
        DOCKSIDE_RELAYER_URL: `http://127.0.0.1:${PORTS.relay}`,
      },
      (l) => l.includes(String(PORTS.web)),
      join(evidenceDir, "web.log"),
      process.platform === "win32",
    );
    const info: SandboxRuntimeInfo = {
      rpcUrl: sb.rpcUrl,
      chainId: sb.chainId,
      accounts: chain.accounts,
      setupTxs: chain.txs,
      buyerKeyFile: chain.buyerKeyFile,
      services,
      serviceKeyFiles: { attestor: attestorFile, policy: policyFile },
      dir,
      evidenceDir,
    };
    const infoFile = join(dir, "runtime-info.json");
    writeFileSync(infoFile, JSON.stringify(info, null, 2));
    process.env["DOCKSIDE_SBX_INFO"] = infoFile;
    ok = true;
  } finally {
    if (!ok) {
      for (const c of children) c.kill();
      sb.stop();
    }
  }
  return async () => {
    for (const c of children) {
      if (process.platform === "win32" && c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"]);
      else c.kill("SIGTERM");
    }
    if (process.env["DOCKSIDE_NEAR_SANDBOX_LOGS"] === "1") process.stdout.write(sb.logs());
    sb.stop();
  };
}
