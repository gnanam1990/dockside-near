/**
 * M55 hosted front: the one public HTTP listener of the container. Real node:http servers on
 * ephemeral loopback ports; the API behind it is the real control API on a real SQLite file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityService } from "@dockside/authority";
import { generateEd25519KeyPair, loadConfig, randomIds, systemClock } from "@dockside/core";
import { Database } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../api/src/app.js";
import { createFront, FRONT_CSP } from "../src/front.js";

const ORIGIN = "https://dockside.example";
let dir: string;
let db: Database;
let api: Server;
let relay: Server;
let front: Server;
let base: string;
const relayed: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];

const listen = (s: Server) =>
  new Promise<number>((res) => s.listen(0, "127.0.0.1", () => res((s.address() as AddressInfo).port)));
const close = (s: Server) => new Promise<void>((res) => s.close(() => res()));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockside-m55-front-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(
    join(web, "index.html"),
    '<!doctype html><div id="root"></div><script src="/assets/app-1a2b3c.js"></script>',
  );
  writeFileSync(join(web, "assets", "app-1a2b3c.js"), "console.log('dockside');");
  writeFileSync(join(web, "assets", "app-1a2b3c.css"), "body{}");
  writeFileSync(join(web, "assets", "plex-1a2b3c.woff2"), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, "outside.txt"), "outside the web root");

  const config = loadConfig({ DOCKSIDE_DB_PATH: join(dir, "api.sqlite"), DOCKSIDE_ORIGIN: ORIGIN });
  db = Database.open(config.DOCKSIDE_DB_PATH);
  db.migrate();
  const authority = new AuthorityService({
    db,
    clock: systemClock,
    ids: randomIds,
    config: {
      origin: ORIGIN,
      network: "near-testnet",
      challengeTtlMs: config.DOCKSIDE_CHALLENGE_TTL_MS,
      sessionTtlMs: config.DOCKSIDE_SESSION_TTL_MS,
      invitationTtlMs: config.DOCKSIDE_INVITATION_TTL_MS,
      recoveryDelayMs: config.DOCKSIDE_RECOVERY_DELAY_MS,
      requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
    },
  });
  api = createServer(createApp({ config, db, authority, clock: systemClock, ids: randomIds }));
  // Stands in for the worker's loopback relay: records exactly what the front forwarded.
  relay = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      relayed.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ relayed: true }));
    });
  });
  const apiPort = await listen(api);
  const relayPort = await listen(relay);
  front = createFront({ webRoot: web, origin: ORIGIN, apiPort, relayPort });
  base = `http://127.0.0.1:${await listen(front)}`;
});

afterAll(async () => {
  await close(front);
  await close(api);
  await close(relay);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("M55 hosted front: web app", () => {
  it("serves the web app with the same security headers as the preview server, plus HSTS", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get("content-security-policy")).toBe(FRONT_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("keeps the content security policy of the web app's own preview configuration", () => {
    const vite = readFileSync(new URL("../../../apps/web/vite.config.ts", import.meta.url), "utf8");
    const directives = FRONT_CSP.split("; ");
    for (const directive of directives) expect(vite).toContain(`"${directive}"`);
    const inVite = /const csp = \[([^\]]+)\]/.exec(vite)?.[1]?.match(/"[^"]+"/g) ?? [];
    expect(directives).toHaveLength(inVite.length);
  });

  it("serves fingerprinted assets with their types and long-lived caching", async () => {
    const js = await fetch(`${base}/assets/app-1a2b3c.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await js.text()).toBe("console.log('dockside');");
    expect((await fetch(`${base}/assets/app-1a2b3c.css`)).headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    const font = await fetch(`${base}/assets/plex-1a2b3c.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(new Uint8Array(await font.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("answers application routes with the app shell and missing files with 404", async () => {
    for (const p of ["/sign-in", "/trades/trd_01ABC/evidence", "/organization?tab=policies"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
    for (const p of ["/assets/missing-000000.js", "/favicon.ico", "/assets/", "/index.html.map"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<div id="root">');
    }
  });

  it("never reads outside the web root", async () => {
    // node:http sends the path exactly as written (fetch would normalise the dots away).
    const raw = (path: string) =>
      new Promise<{ status: number; body: string }>((res, rej) => {
        const r = request(base, { path, method: "GET" }, (m) => {
          let b = "";
          m.on("data", (c) => {
            b += String(c);
          });
          m.on("end", () => res({ status: m.statusCode ?? 0, body: b }));
        });
        r.on("error", rej);
        r.end();
      });
    for (const p of [
      "/../outside.txt",
      "/assets/../../outside.txt",
      "/%2e%2e/outside.txt",
      "/assets/%2e%2e%2f%2e%2e%2foutside.txt",
      "/..%5coutside.txt",
      "//outside.txt",
    ]) {
      const r = await raw(p);
      expect(r.body).not.toContain("outside the web root");
      expect(r.status).toBe(404);
    }
  });

  it("answers HEAD without a body and refuses other methods on the web app", async () => {
    const head = await fetch(`${base}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${base}/sign-in`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
  });
});

describe("M55 hosted front: API and relay", () => {
  it("serves the API health and readiness endpoints", async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const ready = await fetch(`${base}/readyz`);
    expect(await ready.json()).toMatchObject({
      ready: true,
      network: "near-testnet",
      fundedPayouts: "BLOCKED",
    });
  });

  it("forwards API calls with their method, body and headers, and the API's own answer", async () => {
    const key = generateEd25519KeyPair();
    const ok = await fetch(`${base}/v1/bootstrap/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ organizationName: "Front Org", publicKey: key.publicKey }),
    });
    expect(ok.status).toBe(201);
    const ch = (await ok.json()) as { challengeId: string; purpose: string };
    expect(ch.purpose).toBe("ORG_BOOTSTRAP");
    expect(ch.challengeId).toMatch(/^chl_/);
    // The API still sees the caller's Origin: a cross-origin request is refused by the API itself.
    const cross = await fetch(`${base}/v1/bootstrap/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ organizationName: "Front Org", publicKey: key.publicKey }),
    });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe("WRONG_ORIGIN");
    const unauth = await fetch(`${base}/v1/me`);
    expect(unauth.status).toBe(401);
    const missing = await fetch(`${base}/v1/no-such-endpoint`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("forwards relay calls to the worker's loopback relay unchanged", async () => {
    relayed.length = 0;
    const res = await fetch(`${base}/relay/v1/calls?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ methodName: "register_trade" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ relayed: true });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.method).toBe("POST");
    expect(relayed[0]?.url).toBe("/relay/v1/calls?x=1");
    expect(relayed[0]?.headers.origin).toBe(ORIGIN);
    expect(relayed[0]?.body).toBe('{"methodName":"register_trade"}');
    await fetch(`${base}/relay/v1/status`);
    expect(relayed[1]?.url).toBe("/relay/v1/status");
  });

  it("does not treat look-alike paths as API routes", async () => {
    relayed.length = 0;
    for (const p of ["/v1", "/relayx/v1/status", "/healthz/extra", "/v10/me"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
    expect(relayed).toHaveLength(0);
  });

  it("answers 502 with a JSON error when a backend is not reachable", async () => {
    const dead = createFront({
      webRoot: join(dir, "web"),
      origin: "http://127.0.0.1:9039",
      apiPort: 1,
      relayPort: 1,
    });
    const port = await listen(dead);
    try {
      for (const p of ["/healthz", "/v1/me", "/relay/v1/status"]) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({
          error: { code: "UPSTREAM_UNAVAILABLE", message: "the service behind this route is not reachable" },
        });
      }
      // Plain HTTP on loopback: no HSTS.
      expect((await fetch(`http://127.0.0.1:${port}/`)).headers.get("strict-transport-security")).toBeNull();
    } finally {
      await close(dead);
    }
  });
});
