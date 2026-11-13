/**
 * M55 hosted launcher as a real process (`services/hosted/dist/main.js`, built by `pnpm run build`):
 * the fail-closed paths that need no chain. The serving path runs in the container verification
 * (`pnpm run hosted:verify`) against a local nearcore sandbox.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const PORTS = { public: 9037, api: 9038, relay: 9039 };
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dockside-m55-launcher-"));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ nearCodeHash: "11111111111111111111111111111111" }),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function profile(dataDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(PORTS.public),
    HOSTED_BIND: "127.0.0.1",
    HOSTED_API_PORT: String(PORTS.api),
    HOSTED_RELAY_PORT: String(PORTS.relay),
    HOSTED_DATA_DIR: dataDir,
    HOSTED_WEB_ROOT: join(dir, "web"),
    DOCKSIDE_ORIGIN: `http://127.0.0.1:${PORTS.public}`,
    DOCKSIDE_ESCROW_CONTRACT_ID: "escrow.dockside-demo.testnet",
    // Nothing listens here: the chain preflight cannot succeed.
    DOCKSIDE_NEAR_RPC_URL: "http://127.0.0.1:9",
    DOCKSIDE_RELAYER_ACCOUNT_ID: "relayer.dockside-demo.testnet",
    DOCKSIDE_ESCROW_MANIFEST: join(dir, "manifest.json"),
  };
  for (const k of ["PATH", "Path", "SystemRoot"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function run(
  env: Record<string, string>,
): Promise<{ code: number | null; events: Record<string, unknown>[]; err: string }> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += String(d);
    });
    p.stderr.on("data", (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => {
      p.kill();
      rej(new Error(`launcher still running: ${out}${err}`));
    }, 50_000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      const events = out
        .split(/\r?\n/)
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      res({ code, events, err });
    });
  });
}

const listening = (port: number) =>
  new Promise<boolean>((res) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
  });

describe("M55 hosted launcher refuses instead of serving", () => {
  it("exits 78 on an incomplete profile and names the variable, creating nothing", async () => {
    const data = join(dir, "data-incomplete");
    const { DOCKSIDE_RELAYER_ACCOUNT_ID: _gone, ...env } = profile(data);
    const r = await run(env);
    expect(r.code).toBe(78);
    expect(r.events).toEqual([
      expect.objectContaining({
        event: "hosted.refused",
        code: "CONFIG_INVALID",
        name: "DOCKSIDE_RELAYER_ACCOUNT_ID",
      }),
    ]);
    expect(existsSync(data)).toBe(false);
  });

  it("exits 78 when a launcher-owned or unknown setting is supplied, without echoing its value", async () => {
    const data = join(dir, "data-owned");
    const owned = await run({ ...profile(data), DOCKSIDE_RELAYER_KEY_FILE: "/somewhere/else/key.json" });
    expect(owned.code).toBe(78);
    expect(owned.events[0]).toMatchObject({ event: "hosted.refused", name: "DOCKSIDE_RELAYER_KEY_FILE" });
    const unknown = await run({ ...profile(data), DOCKSIDE_RELAYER_KEY: "ed25519:not-a-real-value" });
    expect(unknown.code).toBe(78);
    expect(
      JSON.stringify(unknown.events) + unknown.err + JSON.stringify(owned.events) + owned.err,
    ).not.toMatch(/not-a-real-value|somewhere/);
    expect(existsSync(data)).toBe(false);
  });

  it("ends with the API's failure when the chain preflight cannot pass, and never opens the public port", async () => {
    const data = join(dir, "data-nochain");
    const first = await run(profile(data));
    expect(first.code).toBe(1);
    expect(first.err).toContain("api failed to start");
    expect(first.events.filter((e) => e["event"] === "hosted.child_exited")).toEqual([
      { event: "hosted.child_exited", child: "api", exitCode: 1 },
    ]);
    expect(first.events.some((e) => e["event"] === "hosted.started" || e["event"] === "worker.started")).toBe(
      false,
    );
    expect(await listening(PORTS.public)).toBe(false);
    // The preflight runs before the database is opened: a refused start leaves no database.
    expect(existsSync(join(data, "dockside.sqlite"))).toBe(false);
    expect(existsSync(join(data, "hosted-runtime.json"))).toBe(false);

    // First start on a fresh volume created the three service keys; only public keys were logged.
    const created = first.events.filter((e) => e["event"] === "hosted.key_created");
    expect(created.map((e) => e["key"])).toEqual([
      "audit-export",
      "manifest-attestor",
      "deterministic-policy",
    ]);
    for (const e of created) expect(String(e["publicKey"])).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const seeds = readdirSync(join(data, "keys")).sort();
    expect(seeds).toEqual(["audit-export.seed", "deterministic-policy.seed", "manifest-attestor.seed"]);
    const logged = JSON.stringify(first.events) + first.err;
    const contents = seeds.map((s) => readFileSync(join(data, "keys", s), "utf8").trim());
    for (const c of contents) {
      expect(c).toMatch(/^[0-9a-f]{64}$/);
      expect(logged).not.toContain(c);
    }

    // A later start keeps the keys it finds.
    const second = await run(profile(data));
    expect(second.events.filter((e) => e["event"] === "hosted.key_created")).toEqual([]);
    expect(seeds.map((s) => readFileSync(join(data, "keys", s), "utf8").trim())).toEqual(contents);
  });
});
