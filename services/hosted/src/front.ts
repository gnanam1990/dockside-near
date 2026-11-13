import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

/**
 * The one public HTTP listener of a hosted deployment (M55, ADR-0027). It replaces the Vite preview
 * server of the M43 runbook with the same contract: the production web build with a strict content
 * security policy, `/v1`, `/healthz` and `/readyz` forwarded to the control API, `/relay` forwarded
 * to the worker's loopback party relay. It decides nothing: authentication, authorisation, origin
 * checks, body limits and rate limits stay in the API and the relay, which see the caller's request
 * headers unchanged. TLS is terminated by the host in front of the container.
 */

/** Same policy as apps/web/vite.config.ts (kept equal by services/hosted/test/m55-front.test.ts). */
export const FRONT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Request headers that describe one hop and are not forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
]);

/**
 * Policy of the static proof site (site/proof, ADR-0027) and the payment receipt (M54) when the
 * front serves them under `/proof/` and `/receipt/`: the browser itself reads NEAR, so
 * `connect-src` names exactly the RPC endpoints of the proof manifest, and nothing else differs from
 * the page's own meta policy except that it may not be framed.
 */
export function proofCsp(manifest: unknown): string {
  const networks = (manifest as { networks?: Record<string, { rpc?: unknown }> })?.networks ?? {};
  const origins: string[] = [];
  for (const n of Object.values(networks)) {
    if (!Array.isArray(n.rpc)) continue;
    for (const u of n.rpc) {
      const url = new URL(String(u));
      if (url.protocol !== "https:") throw new Error("proof manifest RPC endpoints must be https");
      if (!origins.includes(url.origin)) origins.push(url.origin);
    }
  }
  if (origins.length === 0) throw new Error("the proof manifest names no RPC endpoint");
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src 'self' ${origins.join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A receipt address `/receipt/<trade id>`; the same id rule as site/proof/lib/receipt.mjs. */
const RECEIPT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface FrontOptions {
  readonly webRoot: string;
  /**
   * The static proof site (site/proof). When set, it is served under `/proof/`, and the payment
   * receipt of a trade at `/receipt/<trade id>` (M54) with the site's files beside it.
   */
  readonly proofRoot?: string;
  /** Public origin; HSTS is sent when it is HTTPS. */
  readonly origin: string;
  readonly apiPort: number;
  readonly relayPort: number;
  /** Upstream response timeout. The relay waits for transaction finality, so this is generous. */
  readonly upstreamTimeoutMs?: number;
}

/** Every file of the web build, by URL path. Requests can only ever name one of these. */
function indexWebRoot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (st.isFile()) files.set(`${prefix}${name}`, full);
    }
  };
  walk(root, "/");
  return files;
}

function apiRoute(path: string): boolean {
  return path === "/healthz" || path === "/readyz" || path.startsWith("/v1/");
}

export function createFront(opts: FrontOptions): Server {
  const files = indexWebRoot(opts.webRoot);
  const shell = files.get("/index.html");
  if (shell === undefined) throw new Error("the web build has no index.html");
  const proof = opts.proofRoot === undefined ? undefined : indexWebRoot(opts.proofRoot);
  const proofManifest = proof?.get("/proof-manifest.json");
  if (proof && (proofManifest === undefined || !proof.has("/receipt.html") || !proof.has("/index.html")))
    throw new Error("the proof site has no proof-manifest.json, index.html or receipt.html");
  const proofHeaders =
    proofManifest === undefined
      ? undefined
      : { "Content-Security-Policy": proofCsp(JSON.parse(readFileSync(proofManifest, "utf8"))) };
  const secure = opts.origin.startsWith("https://");
  const baseHeaders: Record<string, string> = {
    "Content-Security-Policy": FRONT_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };

  const send = (res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer) => {
    res.writeHead(status, { ...baseHeaders, ...headers });
    res.end(body);
  };

  const serveFile = (
    req: IncomingMessage,
    res: ServerResponse,
    file: string,
    cache: string,
    extra: Record<string, string> = {},
  ) => {
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("not found\n"));
      return;
    }
    const headers = {
      "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(body.byteLength),
      "Cache-Control": cache,
      ...extra,
    };
    send(res, 200, headers, req.method === "HEAD" ? undefined : body);
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, upstreamPort: number) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers))
      if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    const unavailable = () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = Buffer.from(
        JSON.stringify({
          error: { code: "UPSTREAM_UNAVAILABLE", message: "the service behind this route is not reachable" },
        }),
      );
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(body);
    };
    const up = request(
      {
        host: "127.0.0.1",
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        timeout: opts.upstreamTimeoutMs ?? 120_000,
      },
      (upRes) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers))
          if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
        if (secure) out["strict-transport-security"] = "max-age=31536000";
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      },
    );
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", unavailable);
    req.on("aborted", () => up.destroy());
    req.pipe(up);
  };

  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
    if (apiRoute(rawPath)) {
      proxy(req, res, opts.apiPort);
      return;
    }
    if (rawPath.startsWith("/relay/")) {
      proxy(req, res, opts.relayPort);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      path = "\0";
    }
    // The proof site and the payment receipt: static files only, read by the browser from NEAR.
    if (proof && proofHeaders && (path.startsWith("/proof/") || path.startsWith("/receipt/"))) {
      const prefix = path.startsWith("/proof/") ? "/proof" : "/receipt";
      const rest = path.slice(prefix.length);
      const named = proof.get(rest === "/" ? (prefix === "/proof" ? "/index.html" : "/receipt.html") : rest);
      const receipt =
        named === undefined && prefix === "/receipt" && RECEIPT_ID.test(rest.slice(1))
          ? proof.get("/receipt.html")
          : undefined;
      // Only files a browser loads (no type declarations or other build leftovers).
      const target = named !== undefined && TYPES[extname(named).toLowerCase()] ? named : receipt;
      if (target === undefined) {
        send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("not found\n"));
        return;
      }
      serveFile(req, res, target, "no-cache", proofHeaders);
      return;
    }
    const file = files.get(path === "/" ? "/index.html" : path);
    if (file !== undefined) {
      serveFile(
        req,
        res,
        file,
        path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      );
      return;
    }
    // Client-side routes get the app shell; anything that names a file, an asset, or is not a
    // plain absolute path does not.
    const last = path.slice(path.lastIndexOf("/") + 1);
    const route =
      path.startsWith("/") &&
      !path.startsWith("/assets/") &&
      !last.includes(".") &&
      !path.includes("//") &&
      !path.includes("\\") &&
      !path.includes("\0");
    if (!route) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, Buffer.from("not found\n"));
      return;
    }
    serveFile(req, res, shell, "no-cache");
  });
  // Slow or idle clients cannot hold sockets open indefinitely.
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  return server;
}
