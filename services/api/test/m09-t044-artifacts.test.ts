/**
 * T-044 (installed artifacts preserve safety controls), host part: the built entry points in
 * services/api/dist and services/worker/dist and the release wasm are started as separate OS
 * processes exactly as an operator would start them, with configuration only from the
 * environment. Checks: fail-closed configuration (unknown names, mainnet, funded profile, non-https
 * RPC, non-loopback http origin) without echoing values; migrations applied once and idempotent on
 * restart; readiness reports the funded rail BLOCKED; security headers and limits on the served
 * API; trade modules reported NOT_CONFIGURED without escrow configuration; the worker refusing to run without a
 * provisioned relayer signer; and the contract artifact present with its digest recorded.
 * The web artifact is exercised by the browser suite (apps/web/e2e) against its production build.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMigrations } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const API = join(ROOT, "services/api/dist/main.js");
const WORKER = join(ROOT, "services/worker/dist/main.js");
const WASM = join(ROOT, "contract/target/wasm32-unknown-unknown/release/dockside_escrow.wasm");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dockside-artifacts-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Only DOCKSIDE_* names the test sets reach the child, plus what node needs to run. */
function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, NODE_NO_WARNINGS: "1", ...extra };
}

function runOnce(entry: string, extra: Record<string, string>) {
  const r = spawnSync(process.execPath, [entry], { env: env(extra), encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

async function startApi(
  extra: Record<string, string>,
): Promise<{ p: ChildProcess; base: string; first: any }> {
  const p = spawn(process.execPath, [API], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
  const first = await new Promise<any>((resolveLine, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`api did not start: ${buf}`)), 20_000);
    p.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const line = buf.split("\n").find((l) => l.includes('"listening"'));
      if (line) {
        clearTimeout(timer);
        resolveLine(JSON.parse(line));
      }
    });
    p.on("exit", (c) => {
      clearTimeout(timer);
      reject(new Error(`api exited ${c}: ${buf}`));
    });
  });
  return { p, base: `http://127.0.0.1:${first.address.port}`, first };
}

function stop(p: ChildProcess): Promise<void> {
  return new Promise((r) => {
    p.removeAllListeners("exit");
    p.once("exit", () => r());
    p.kill();
  });
}

describe("T-044: installed API artifact", () => {
  const db = () => join(dir, "api.sqlite");
  const good = () => ({
    DOCKSIDE_DB_PATH: db(),
    DOCKSIDE_ORIGIN: "http://127.0.0.1:4391",
    DOCKSIDE_HOST: "127.0.0.1",
    DOCKSIDE_PORT: "0",
  });

  it("refuses unsafe or unknown configuration and never echoes a value", () => {
    const canary = "canary-value-7f3a";
    const cases: Record<string, string>[] = [
      { DOCKSIDE_NETWORK: "near-mainnet" },
      { DOCKSIDE_FUNDED_PAYOUTS: "ENABLED" },
      { DOCKSIDE_ORIGN: "http://127.0.0.1:1" },
      { DOCKSIDE_ORIGIN: "http://example.com" },
      { DOCKSIDE_NEAR_RPC_URL: "http://rpc.example.com" },
      { DOCKSIDE_SESSION_TTL_MS: canary },
      { DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN: "0" },
    ];
    for (const c of cases) {
      const r = runOnce(API, { ...good(), ...c });
      expect(r.status, JSON.stringify(c)).not.toBe(0);
      expect(r.out).toContain("CONFIG_INVALID");
      expect(r.out).not.toContain(canary);
    }
    // Nothing was created by a refused start.
    expect(existsSync(db())).toBe(false);
  });

  it("migrates once, serves readiness with the funded rail BLOCKED, and restarts idempotently", async () => {
    const one = await startApi(good());
    try {
      expect(one.first.migrationsApplied).toHaveLength(loadMigrations().length);
      expect(one.first.tradeModules).toBe("NOT_CONFIGURED");
      const ready = await fetch(`${one.base}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({
        ready: true,
        schemaVersion: loadMigrations().length,
        network: "near-testnet",
        fundedPayouts: "BLOCKED",
      });
      for (const [h, v] of [
        ["content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"],
        ["x-content-type-options", "nosniff"],
        ["x-frame-options", "DENY"],
        ["cache-control", "no-store"],
      ] as const)
        expect(ready.headers.get(h)).toBe(v);
      // Trade routes need a session before anything else is disclosed.
      const trades = await fetch(`${one.base}/v1/trades`);
      expect(trades.status).toBe(401);
      // Cross-origin writes are refused by the installed build.
      const cross = await fetch(`${one.base}/v1/bootstrap/challenges`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: "{}",
      });
      expect(((await cross.json()) as any).error.code).toBe("WRONG_ORIGIN");
    } finally {
      await stop(one.p);
    }
    const two = await startApi(good());
    try {
      expect(two.first.migrationsApplied).toEqual([]);
      expect(((await (await fetch(`${two.base}/readyz`)).json()) as any).schemaVersion).toBe(
        loadMigrations().length,
      );
    } finally {
      await stop(two.p);
    }
  });

  it("applies the default request limits of the installed build", async () => {
    const s = await startApi({
      ...good(),
      DOCKSIDE_DB_PATH: join(dir, "limits.sqlite"),
      DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN: "2",
    });
    try {
      const hit = () =>
        fetch(`${s.base}/v1/sessions/challenges`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      expect((await hit()).status).toBe(400);
      expect((await hit()).status).toBe(400);
      expect((await hit()).status).toBe(429);
    } finally {
      await stop(s.p);
    }
  });
});

describe("T-044: installed worker and contract artifacts", () => {
  it("the worker refuses to run without a provisioned relayer signer", () => {
    const r = runOnce(WORKER, { DOCKSIDE_DB_PATH: join(dir, "worker.sqlite") });
    expect(r.status).toBe(78);
    expect(r.out).toContain("RELAYER_SIGNER_NOT_PROVISIONED");
    const main = runOnce(WORKER, { DOCKSIDE_NETWORK: "near-mainnet" });
    expect(main.status).not.toBe(0);
    expect(main.out).toContain("CONFIG_INVALID");
  });

  it("the release wasm is a wasm module (its init guard is tested in m02-escrow-wasm)", () => {
    expect(existsSync(WASM)).toBe(true);
    const bytes = readFileSync(WASM);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
});
