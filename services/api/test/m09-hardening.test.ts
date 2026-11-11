/**
 * M09 hardening at the HTTP boundary: request limits on unauthenticated routes (per client
 * address) and authenticated routes (per presented session), counted before any body is read or
 * signature verified, with invented session tokens also counted against the address; health
 * probes exempt; the limiter's memory bounded and failing closed; socket-level server limits.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, randomIds } from "@dockside/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Actor,
  bootstrap,
  closeHarnesses,
  makeHarness,
  ORIGIN,
} from "../../../packages/authority/test/helpers.js";
import { createApp, hardenServer, RateLimiter, SERVER_LIMITS } from "../src/app.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  closeHarnesses();
});

async function start(limits: { unauth: number; session: number }) {
  const h = makeHarness();
  const config = loadConfig({
    DOCKSIDE_DB_PATH: h.dbPath,
    DOCKSIDE_ORIGIN: ORIGIN,
    DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN: String(limits.unauth),
    DOCKSIDE_RATE_LIMIT_SESSION_PER_MIN: String(limits.session),
  });
  const server = hardenServer(
    createServer(createApp({ config, db: h.db, authority: h.svc, clock: h.clock, ids: randomIds })),
  );
  servers.push(server);
  const base = await new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const me = (a: Actor) =>
    fetch(`${base}/v1/me`, {
      headers: {
        authorization: `Dockside-Session ${a.grant?.sessionToken}`,
        "dockside-proof": Buffer.from(JSON.stringify(a.proof("GET", "/v1/me", ""))).toString("base64url"),
      },
    });
  return { h, base, post, me, server };
}

describe("M09 request limits", () => {
  it("limits unauthenticated challenge creation per client address and recovers after the window", async () => {
    const s = await start({ unauth: 3, session: 100 });
    const body = { organizationName: "Flood Ltd", publicKey: "not-a-key" };
    for (let i = 0; i < 3; i++) expect((await s.post("/v1/bootstrap/challenges", body)).status).toBe(400);
    const limited = await s.post("/v1/bootstrap/challenges", body);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const err = (await limited.json()) as { error: { code: string; details: Record<string, unknown> } };
    expect(err.error.code).toBe("RATE_LIMITED");
    // Every unauthenticated route shares the address window, including unknown paths.
    expect((await s.post("/v1/sessions/challenges", { principalId: "x", publicKey: "y" })).status).toBe(429);
    expect((await fetch(`${s.base}/v1/nothing-here`)).status).toBe(429);
    // Health probes stay answerable for orchestration.
    expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.base}/readyz`)).status).toBe(200);
    s.h.clock.advance(60_000);
    expect((await s.post("/v1/bootstrap/challenges", body)).status).toBe(400);
  });

  it("limits each authenticated session separately and counts invented tokens per address", async () => {
    const s = await start({ unauth: 4, session: 2 });
    const a = bootstrap(s.h, "Acme Imports");
    const b = bootstrap(s.h, "Harbor Supply");
    expect((await s.me(a)).status).toBe(200);
    expect((await s.me(a)).status).toBe(200);
    const third = await s.me(a);
    expect(third.status).toBe(429);
    // Another session is not affected by the first one's window.
    expect((await s.me(b)).status).toBe(200);
    // Made-up session tokens each get a fresh session window, so failures count per address.
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${s.base}/v1/me`, {
        headers: { authorization: `Dockside-Session invented-${i}`, "dockside-proof": "e30" },
      });
      expect([400, 401]).toContain(r.status);
    }
    const r = await fetch(`${s.base}/v1/me`, {
      headers: { authorization: "Dockside-Session invented-x", "dockside-proof": "e30" },
    });
    expect(r.status).toBe(429);
    // A limited request never reaches authentication: no session state changed for it.
    s.h.clock.advance(60_000);
    expect((await s.me(a)).status).toBe(200);
  });

  it("bounds the limiter's memory and refuses new keys instead of evicting live windows", () => {
    const clock = { now: () => 1_000 };
    const l = new RateLimiter(clock, 60_000, 3);
    l.take("a", 10);
    l.take("b", 10);
    l.take("c", 10);
    expect(() => l.take("d", 10)).toThrow(/too many requests/);
    expect(l.trackedKeys).toBe(3);
    // Existing windows keep counting.
    l.take("a", 10);
    const later = new RateLimiter({ now: () => 1_000 }, 60_000, 1);
    later.take("x", 1);
    expect(() => later.take("x", 1)).toThrow(/too many requests/);
  });

  it("applies socket-level header, request and keep-alive limits", async () => {
    const s = await start({ unauth: 10, session: 10 });
    expect(s.server.headersTimeout).toBe(SERVER_LIMITS.headersTimeout);
    expect(s.server.requestTimeout).toBe(SERVER_LIMITS.requestTimeout);
    expect(s.server.keepAliveTimeout).toBe(SERVER_LIMITS.keepAliveTimeout);
    expect(s.server.maxHeadersCount).toBe(SERVER_LIMITS.maxHeadersCount);
    expect(s.server.maxRequestsPerSocket).toBe(SERVER_LIMITS.maxRequestsPerSocket);
  });
});
