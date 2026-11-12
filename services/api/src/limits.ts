import type { Server } from "node:http";
import { type Clock, fail, sha256, toHex } from "@dockside/core";

/**
 * Fixed-window request limiter (SECURITY.md "rate limits"). Keys are a client address for
 * unauthenticated routes and failed authentications, and a digest of the session token for
 * authenticated routes, allocated only once the token has authenticated (so invented tokens cannot
 * fill the table); the token itself is never kept. Memory is bounded: when the table is full, expired windows are
 * swept, and a new key that still does not fit is refused (fail closed) rather than evicting a
 * live window an attacker could otherwise reset.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 50_000,
  ) {}

  /** Count one request for `key`; throws RATE_LIMITED once `limit` is reached in the window. */
  take(key: string, limit: number): void {
    const now = this.clock.now();
    let w = this.windows.get(key);
    if (w && now - w.start >= this.windowMs) {
      this.windows.delete(key);
      w = undefined;
    }
    if (!w) {
      if (this.windows.size >= this.maxKeys) this.sweep(now);
      if (this.windows.size >= this.maxKeys) this.refuse(this.windowMs);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= limit) this.refuse(w.start + this.windowMs - now);
    w.count += 1;
  }

  /**
   * Refuse if `key` already has a live window that has reached `limit`, without counting or
   * allocating anything. Used ahead of work whose key is only known to be legitimate afterwards.
   */
  check(key: string, limit: number): void {
    const now = this.clock.now();
    const w = this.windows.get(key);
    if (w && now - w.start < this.windowMs && w.count >= limit) this.refuse(w.start + this.windowMs - now);
  }

  /** Whether `key` has a live (unexpired) window. */
  has(key: string): boolean {
    const w = this.windows.get(key);
    return w !== undefined && this.clock.now() - w.start < this.windowMs;
  }

  get trackedKeys(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }

  private refuse(retryMs: number): never {
    return fail("RATE_LIMITED", "too many requests", {
      retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
    });
  }
}

/** Limiter key for a presented session token: a digest, so no token is held in memory. */
export function sessionKey(token: string): string {
  return `s:${toHex(sha256(new TextEncoder().encode(token))).slice(0, 32)}`;
}

/** Limiter key for a client address. */
export function addressKey(address: string | undefined): string {
  return `a:${address ?? "unknown"}`;
}

/**
 * Socket-level limits for the node:http server: slow or oversized header phases and requests
 * that never finish are cut off, and idle keep-alive sockets are reclaimed.
 */
export const SERVER_LIMITS = {
  headersTimeout: 15_000,
  requestTimeout: 30_000,
  keepAliveTimeout: 5_000,
  maxHeadersCount: 64,
  maxRequestsPerSocket: 1_000,
} as const;

export function hardenServer(server: Server): Server {
  server.headersTimeout = SERVER_LIMITS.headersTimeout;
  server.requestTimeout = SERVER_LIMITS.requestTimeout;
  server.keepAliveTimeout = SERVER_LIMITS.keepAliveTimeout;
  server.maxHeadersCount = SERVER_LIMITS.maxHeadersCount;
  server.maxRequestsPerSocket = SERVER_LIMITS.maxRequestsPerSocket;
  return server;
}
