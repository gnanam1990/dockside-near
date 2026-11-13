/**
 * M54: the hosted front serves the static proof site (site/proof, the committed files) under
 * `/proof/` and the payment receipt of a trade at `/receipt/<trade id>`, with a content security
 * policy that lets the reader's browser reach exactly the RPC endpoints of the proof manifest.
 * Real node:http servers on ephemeral loopback ports; no API is needed for these routes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFront, FRONT_CSP, PROOF_CSP } from "../src/front.js";

const PROOF = fileURLToPath(new URL("../../../site/proof/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(PROOF, "proof-manifest.json"), "utf8"));
const TRADE = "trd_197c633d724eeb2cddc64d6dabf55976";
let dir: string;
let front: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockside-m54-front-"));
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web", "index.html"), '<!doctype html><div id="root"></div>');
  // Nothing listens on the API and relay ports: these routes must not need them.
  front = createFront({
    webRoot: join(dir, "web"),
    proof: { root: PROOF, attackPort: 9 },
    origin: "https://dockside.example",
    apiPort: 9,
    relayPort: 9,
  });
  await new Promise<void>((ok) => front.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((ok) => front.close(() => ok()));
  rmSync(dir, { recursive: true, force: true });
});

const metaCsp = (file: string) =>
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
    readFileSync(join(PROOF, file), "utf8"),
  )?.[1];

function raw(path: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
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
}

describe("M54 hosted front: payment receipts and the proof site", () => {
  it("answers /receipt/<trade id> with the receipt page and a policy naming the manifest's RPC endpoints", async () => {
    const res = await fetch(`${base}/receipt/${TRADE}?network=testnet`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(readFileSync(join(PROOF, "receipt.html"), "utf8"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(PROOF_CSP);
    for (const n of Object.values(manifest.networks as Record<string, { rpc: string[] }>))
      for (const u of n.rpc) expect(csp).toContain(new URL(u).origin);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("sends the same policy as the pages' own meta policy, plus no framing", () => {
    for (const file of ["receipt.html", "index.html"])
      expect(PROOF_CSP).toBe(`${metaCsp(file)}; frame-ancestors 'none'`);
  });

  it("serves the receipt's scripts, styles and manifest beside it, as module scripts", async () => {
    for (const [path, type] of [
      ["/receipt/receipt.mjs", "text/javascript; charset=utf-8"],
      ["/receipt/lib/qr.mjs", "text/javascript; charset=utf-8"],
      ["/receipt/lib/receipt.mjs", "text/javascript; charset=utf-8"],
      ["/receipt/proof.css", "text/css; charset=utf-8"],
      ["/receipt/proof-manifest.json", "application/json; charset=utf-8"],
      ["/proof/", "text/html; charset=utf-8"],
      ["/proof/receipt.html", "text/html; charset=utf-8"],
      ["/proof/app.mjs", "text/javascript; charset=utf-8"],
    ] as const) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(res.headers.get("content-security-policy")).toBe(PROOF_CSP);
    }
    expect(await (await fetch(`${base}/proof/`)).text()).toBe(
      readFileSync(join(PROOF, "index.html"), "utf8"),
    );
    expect(await (await fetch(`${base}/receipt/`)).text()).toBe(
      readFileSync(join(PROOF, "receipt.html"), "utf8"),
    );
  });

  it("refuses type declarations, malformed ids and paths outside the proof site", async () => {
    for (const p of [
      "/receipt/lib/qr.d.mts",
      "/receipt/bad%20id",
      "/receipt/a/b",
      "/proof/missing.mjs",
      "/receipt/../../package.json",
      "/receipt/%2e%2e/%2e%2e/package.json",
      "/proof/..%5c..%5cpackage.json",
    ]) {
      const r = await raw(p);
      expect(r.status, p).toBe(404);
      expect(r.body).not.toContain('"packageManager"');
    }
  });

  it("leaves the web app and its policy unchanged", async () => {
    const res = await fetch(`${base}/trades/${TRADE}/release`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    expect(res.headers.get("content-security-policy")).toBe(FRONT_CSP);
  });
});
