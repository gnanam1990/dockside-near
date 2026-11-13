/**
 * M53: the attack relay's HTTP face, the hosted front that serves the console under /proof/ and
 * forwards its API, and the launcher profile of the relay process. Requests here never reach a
 * chain: every route tested refuses before an attempt (validation, RELAY_OFF), or is a static file.
 * A real attempt over HTTP is in m53-attack-core.test.ts (real core) and
 * m53-attack-sandbox.test.ts (real nearcore).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AttackRelay } from "../src/attack/relay.js";
import { createAttackServer } from "../src/attack/server.js";
import { createFront, FRONT_CSP, PROOF_CSP } from "../src/front.js";
import { resolveHostedProfile } from "../src/profile.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const listen = (s: Server) =>
  new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));

/** A relay that must never be asked to send: every request below is refused before that. */
const untouchable = {
  attempt: async () => {
    throw new Error("attempt must not be reached");
  },
  status: async () => ({ enabled: true }),
  log: [],
} as unknown as AttackRelay;

describe("attack relay HTTP routes", () => {
  let off: Server;
  let on: Server;
  let offUrl = "";
  let onUrl = "";
  beforeAll(async () => {
    off = createAttackServer({ relay: null, offReason: "the demo trade has not been created yet" });
    on = createAttackServer({ relay: untouchable, allowedOrigins: ["https://gnanam1990.github.io"] });
    offUrl = `http://127.0.0.1:${await listen(off)}/attack/api`;
    onUrl = `http://127.0.0.1:${await listen(on)}/attack/api`;
  });
  afterAll(() => {
    off.close();
    on.close();
  });
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/attempt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("answers RELAY_OFF with the reason when no relay is configured", async () => {
    const r = await fetch(`${offUrl}/status`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({
      error: { code: "RELAY_OFF", message: "the demo trade has not been created yet" },
    });
    expect((await post(offUrl, '{"attack":"replay-approval"}')).status).toBe(503);
  });

  it("accepts only one of the five attack ids, as a small JSON body", async () => {
    const bad = await post(onUrl, '{"attack":"drain-everything"}');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("UNKNOWN_ATTACK");
    expect((await post(onUrl, "not json")).status).toBe(400);
    expect((await post(onUrl, JSON.stringify({ attack: "x".repeat(300) }))).status).toBe(413);
    const text = await fetch(`${onUrl}/attempt`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(text.status).toBe(415);
    // Extra fields never reach the chain: the body is reduced to the attack id (still refused here
    // because the id is missing).
    expect((await post(onUrl, '{"method":"execute_release","args":{}}')).status).toBe(400);
  });

  it("refuses attempts from other sites, and answers CORS only for the configured origin", async () => {
    const evil = await post(onUrl, '{"attack":"replay-approval"}', { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const pre = await fetch(`${onUrl}/attempt`, {
      method: "OPTIONS",
      headers: { origin: "https://gnanam1990.github.io" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://gnanam1990.github.io");
    const other = await fetch(`${onUrl}/attempt`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(other.status).toBe(403);
    const status = await fetch(`${onUrl}/status`, { headers: { origin: "https://gnanam1990.github.io" } });
    expect(status.headers.get("access-control-allow-origin")).toBe("https://gnanam1990.github.io");
    expect(status.headers.get("cache-control")).toBe("no-store");
  });

  it("has no other routes", async () => {
    expect((await fetch(`${onUrl}/attempt`)).status).toBe(404);
    expect((await fetch(`${onUrl.replace("/attack/api", "")}/v1/anything`)).status).toBe(404);
  });
});

describe("hosted front: /proof/ and the console", () => {
  let api: Server;
  let front: Server;
  let base = "";
  let web = "";
  beforeAll(async () => {
    api = createAttackServer({ relay: null, offReason: "no demo key is configured on this deployment" });
    const attackPort = await listen(api);
    web = mkdtempSync(join(tmpdir(), "dockside-m53-web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>app</title>");
    front = createFront({
      webRoot: web,
      origin: "https://dockside.example",
      apiPort: 9,
      relayPort: 9,
      proof: { root: join(ROOT, "site/proof"), attackPort },
    });
    base = `http://127.0.0.1:${await listen(front)}`;
  });
  afterAll(() => {
    front.close();
    api.close();
    rmSync(web, { recursive: true, force: true });
  });

  it("serves the console and the proof page with the proof policy (RPC endpoints allowed)", async () => {
    for (const p of ["/proof/attack/", "/proof/attack/index.html", "/proof/"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("content-security-policy")).toBe(PROOF_CSP);
    }
    expect(PROOF_CSP).toContain("connect-src 'self' https://test.rpc.fastnear.com");
    const js = await fetch(`${base}/proof/lib/attack-read.mjs`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const cfg = (await (await fetch(`${base}/proof/attack/attack-demo.json`)).json()) as { schema: string };
    expect(cfg.schema).toBe("dockside/attack-demo@1");
    // The app keeps its own, stricter policy.
    expect((await fetch(`${base}/`)).headers.get("content-security-policy")).toBe(FRONT_CSP);
  });

  it("redirects /attack to the console and forwards its API to the relay process", async () => {
    const r = await fetch(`${base}/attack`, { redirect: "manual" });
    expect([r.status, r.headers.get("location")]).toEqual([302, "/proof/attack/"]);
    const s = await fetch(`${base}/proof/attack/api/status`);
    expect(s.status).toBe(503);
    expect(((await s.json()) as { error: { code: string; message: string } }).error).toEqual({
      code: "RELAY_OFF",
      message: "no demo key is configured on this deployment",
    });
  });

  it("serves nothing else under /proof/", async () => {
    // Files are looked up in an index of site/proof, never joined onto a path: no traversal.
    // Raw request paths: fetch would normalise the dot segments away before sending.
    const raw = (path: string) =>
      new Promise<number>((ok, no) => {
        const u = new URL(base);
        request({ host: u.hostname, port: u.port, path }, (r) => {
          r.resume();
          ok(r.statusCode ?? 0);
        })
          .on("error", no)
          .end();
      });
    for (const p of [
      "/proof/nope.mjs",
      "/proof/../package.json",
      "/proof/attack/../../Dockerfile",
      "/proof/%2e%2e/package.json",
    ])
      expect(await raw(p)).toBe(404);
    expect((await fetch(`${base}/proof/attack/`, { method: "POST" })).status).toBe(405);
  });
});

describe("launcher profile of the attack relay", () => {
  const env = {
    DOCKSIDE_ESCROW_CONTRACT_ID: "escrow.dockside-demo.testnet",
    DOCKSIDE_NEAR_RPC_URL: "https://test.rpc.fastnear.com",
    DOCKSIDE_RELAYER_ACCOUNT_ID: "relayer.dockside-demo.testnet",
    DOCKSIDE_ESCROW_MANIFEST: "/app/manifests/escrow.json",
    DOCKSIDE_ORIGIN: "https://dockside.example",
    HOSTED_DATA_DIR: "/data",
    HOSTED_RELAYER_KEY_FILE: "/run/dockside/relayer-key.json",
    HOSTED_ATTACK_KEY_FILE: "/run/dockside/attack-key.json",
  };
  const resolve = (e: Record<string, string>) => resolveHostedProfile(e, { appRoot: "/app" });

  it("gives the relay its own settings only, and its key to no other process", () => {
    const p = resolve(env);
    expect(Object.keys(p.attackEnv).sort()).toEqual(
      [
        "DOCKSIDE_NEAR_RPC_URL",
        "HOSTED_ATTACK_ALLOWED_ORIGINS",
        "HOSTED_ATTACK_CONFIG",
        "HOSTED_ATTACK_KEY_FILE",
        "HOSTED_ATTACK_LOG",
        "HOSTED_ATTACK_PORT",
        "NODE_ENV",
        "NODE_NO_WARNINGS",
      ].sort(),
    );
    expect(p.attackEnv["HOSTED_ATTACK_KEY_FILE"]).toBe("/run/dockside/attack-key.json");
    expect(JSON.stringify(p.apiEnv)).not.toContain("attack-key");
    expect(JSON.stringify(p.workerEnv)).not.toContain("attack-key");
    expect(JSON.stringify(p.attackEnv)).not.toContain("relayer-key");
    expect(p.attackPort).toBe(8789);
    expect(p.attackEnv["HOSTED_ATTACK_CONFIG"]).toBe(
      join("/app", "site", "proof", "attack", "attack-demo.json"),
    );
    expect(p.attackEnv["HOSTED_ATTACK_LOG"]).toBe(join("/data", "attack-attempts.jsonl"));
  });

  it("refuses a port taken by another process and an origin list that is not https origins", () => {
    expect(() => resolve({ ...env, HOSTED_ATTACK_PORT: "8787" })).toThrow(/attack relay needs its own port/);
    expect(() => resolve({ ...env, HOSTED_ATTACK_ALLOWED_ORIGINS: "http://x.example" })).toThrow(
      /https origins/,
    );
    expect(
      resolve({ ...env, HOSTED_ATTACK_ALLOWED_ORIGINS: "https://gnanam1990.github.io" }).attackEnv[
        "HOSTED_ATTACK_ALLOWED_ORIGINS"
      ],
    ).toBe("https://gnanam1990.github.io");
  });
});
