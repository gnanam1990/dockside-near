/**
 * Security regression (external automated scan, vuln-0004): invented session tokens must not
 * allocate limiter windows before the token resolves to a real session, and once an address has
 * spent its failure budget further invented tokens are refused before authentication runs (no
 * session lookup, no AUTH_DENIED audit row). A flood of invented tokens therefore cannot fill the
 * limiter table and deny service to other clients.
 */
import { createServer, request, type Server } from "node:http";
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
import { createApp, RateLimiter } from "../src/app.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  closeHarnesses();
});

async function start(limits: { unauth: number; session: number }, maxKeys: number) {
  const h = makeHarness();
  const config = loadConfig({
    DOCKSIDE_DB_PATH: h.dbPath,
    DOCKSIDE_ORIGIN: ORIGIN,
    DOCKSIDE_RATE_LIMIT_UNAUTH_PER_MIN: String(limits.unauth),
    DOCKSIDE_RATE_LIMIT_SESSION_PER_MIN: String(limits.session),
  });
  const limiter = new RateLimiter(h.clock, 60_000, maxKeys);
  const server = createServer(
    createApp({ config, db: h.db, authority: h.svc, clock: h.clock, ids: randomIds, limiter }),
  );
  servers.push(server);
  const base = await new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  // A legitimate client on another source address than the flooding one.
  const me = (a: Actor) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const r = request(
        `${base}/v1/me`,
        {
          localAddress: "127.0.0.2",
          headers: {
            authorization: `Dockside-Session ${a.grant?.sessionToken}`,
            "dockside-proof": Buffer.from(JSON.stringify(a.proof("GET", "/v1/me", ""))).toString("base64url"),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      r.on("error", reject);
      r.end();
    });
  const invented = (i: number) =>
    fetch(`${base}/v1/me`, {
      headers: {
        authorization: `Dockside-Session ${String(i).padStart(43, "A")}`,
        "dockside-proof": Buffer.from(
          JSON.stringify({
            sessionId: "ses_x",
            issuedAt: h.clock.now(),
            nonce: "0".repeat(32),
            signature: "x",
          }),
        ).toString("base64url"),
      },
    });
  const denials = () =>
    Number(
      (h.db.get("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'AUTH_DENIED'") as { n: number })
        .n,
    );
  return { h, base, me, invented, limiter, denials };
}

describe("vuln-0004 limiter table exhaustion", () => {
  it("does not allocate a limiter window per invented session token", async () => {
    const s = await start({ unauth: 5, session: 100 }, 50);
    for (let i = 0; i < 40; i++) expect([400, 401, 429]).toContain((await s.invented(i)).status);
    // One window for the attacker's address, none for the invented tokens.
    expect(s.limiter.trackedKeys).toBeLessThanOrEqual(1);
  });

  it("keeps new clients and new sessions served while invented tokens flood in", async () => {
    const s = await start({ unauth: 5, session: 100 }, 8);
    for (let i = 0; i < 60; i++) await s.invented(i);
    const a = bootstrap(s.h, "Acme Imports");
    expect((await s.me(a)).status).toBe(200);
    // An established session keeps its own window even on the flooding address's budget.
    expect((await s.me(a)).status).toBe(200);
  });

  it("refuses further invented tokens before authentication once the address budget is spent", async () => {
    const s = await start({ unauth: 3, session: 100 }, 1000);
    const before = s.denials();
    for (let i = 0; i < 20; i++) await s.invented(i);
    // Only the first `unauth` failures reach authentication (and its audit write).
    expect(s.denials() - before).toBeLessThanOrEqual(3);
    expect((await s.invented(99)).status).toBe(429);
  });
});
