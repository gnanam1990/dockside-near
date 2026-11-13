import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ATTACK_IDS, AttackError, type AttackId } from "./attacks.js";
import type { AttackRelay } from "./relay.js";

/**
 * HTTP face of the attack relay (M53): three routes under `/attack/api/`, JSON only.
 *
 *   GET  /attack/api/status     is the console enabled and armed, attempts so far, limits
 *   POST /attack/api/attempt    {"attack":"<id>"} -> the transaction and the escrow's answer
 *   GET  /attack/api/attempts   the attempts this process sent (newest last)
 *
 * The body is at most 256 bytes and names one of the five attacks; nothing else a caller sends
 * reaches the chain. Cross-origin calls are answered only for the configured origins (the Pages
 * copy of the page). The client used for the per-client limit is the first X-Forwarded-For hop the
 * container host adds, else the socket address.
 */

const STATUS: Record<string, number> = {
  UNKNOWN_ATTACK: 400,
  CONFIG_INVALID: 500,
  DEMO_NOT_SET_UP: 503,
  DEMO_STALE: 409,
  DEMO_NOT_ARMED: 409,
  RATE_LIMITED: 429,
  BUSY: 429,
  KEY_REFUSED: 500,
  SEND_FAILED: 502,
  ACCEPTED: 503,
};

export interface AttackServerOptions {
  readonly relay: AttackRelay | null;
  /** Why the relay is off, when `relay` is null (shown to the page, which then replays). */
  readonly offReason?: string;
  /** Origins allowed to call cross-origin (exact match), e.g. the GitHub Pages origin. */
  readonly allowedOrigins?: readonly string[];
}

function clientOf(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export function createAttackServer(o: AttackServerOptions): Server {
  const allowed = new Set(o.allowedOrigins ?? []);
  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ) => {
    const text = Buffer.from(JSON.stringify(body));
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      typeof origin === "string" && allowed.has(origin)
        ? {
            "Access-Control-Allow-Origin": origin,
            Vary: "Origin",
            "Access-Control-Allow-Headers": "content-type",
          }
        : {};
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": String(text.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...cors,
      ...extra,
    });
    res.end(text);
  };
  const error = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    if (e instanceof AttackError) {
      const extra: Record<string, string> =
        e.retryAfterMs !== null
          ? { "Retry-After": String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) }
          : {};
      send(
        req,
        res,
        STATUS[e.code] ?? 500,
        { error: { code: e.code, message: e.message, retryAfterMs: e.retryAfterMs } },
        extra,
      );
      return;
    }
    send(req, res, 502, { error: { code: "UPSTREAM", message: "the chain could not be read" } });
  };

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") {
      req.resume();
      if (typeof origin === "string" && allowed.has(origin)) {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        });
      } else res.writeHead(403);
      res.end();
      return;
    }
    if (!o.relay) {
      req.resume();
      send(req, res, 503, {
        error: { code: "RELAY_OFF", message: o.offReason ?? "the attack relay is not configured" },
      });
      return;
    }
    const relay = o.relay;
    if (req.method === "GET" && path === "/attack/api/status") {
      relay.status().then(
        (s) => send(req, res, 200, s),
        (e) => error(req, res, e),
      );
      return;
    }
    if (req.method === "GET" && path === "/attack/api/attempts") {
      send(req, res, 200, { attempts: relay.log });
      return;
    }
    if (req.method === "POST" && path === "/attack/api/attempt") {
      if (
        typeof origin === "string" &&
        origin !== `http://${req.headers.host}` &&
        origin !== `https://${req.headers.host}` &&
        !allowed.has(origin)
      ) {
        req.resume();
        send(req, res, 403, {
          error: { code: "WRONG_ORIGIN", message: "this origin may not send attempts" },
        });
        return;
      }
      const ct = String(req.headers["content-type"] ?? "");
      if (!ct.startsWith("application/json")) {
        req.resume();
        send(req, res, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "send application/json" } });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.byteLength;
        if (size > 256) {
          send(req, res, 413, { error: { code: "LIMIT_EXCEEDED", message: "body too large" } });
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (res.headersSent) return;
        let id: unknown;
        try {
          id = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { attack?: unknown }).attack;
        } catch {
          send(req, res, 400, { error: { code: "MALFORMED_JSON", message: "body is not JSON" } });
          return;
        }
        if (typeof id !== "string" || !ATTACK_IDS.includes(id as AttackId)) {
          send(req, res, 400, {
            error: { code: "UNKNOWN_ATTACK", message: `attack must be one of ${ATTACK_IDS.join(", ")}` },
          });
          return;
        }
        relay.attempt(id as AttackId, clientOf(req)).then(
          (r) => send(req, res, 200, r),
          (e) => error(req, res, e),
        );
      });
      return;
    }
    req.resume();
    send(req, res, 404, { error: { code: "NOT_FOUND", message: "no such route" } });
  });
}
