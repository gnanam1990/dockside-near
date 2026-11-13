import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DocksideError } from "@dockside/core";
import type { FunctionCall } from "@dockside/near";
import type { RelayResult } from "./submit.js";

/**
 * Party-call relay (M43): the real-chain counterpart of the local stack's `/relay/v1/*`. The web
 * server proxies `/relay` here; the browser hands it a contract call the API prepared, whose party
 * signatures are inside the arguments (the contract re-verifies every one). The relay pays gas
 * with the relayer's function-call key and never sees or holds a party key.
 *
 * It listens on loopback only and accepts only:
 * - a JSON POST (no simple cross-site form posts) whose Origin, when present, is the web origin;
 * - a call to the configured escrow, with no attached deposit, to a method on the allowlist (the
 *   calls a party's own wallet must send — `fund` and the unexpected-asset sender calls — are not);
 * - at most `perMinute` calls per minute, bodies up to 256 KiB, gas up to 300 Tgas.
 */

/** Escrow methods whose authority is a signature inside the arguments, so anyone may relay them. */
export const RELAYABLE_METHODS: ReadonlySet<string> = new Set([
  "register_trade",
  "register_evidence_policy",
  "submit_manifest_attestation",
  "submit_inspection",
  "set_hold",
  "resolve_hold",
  "revoke_bound_key",
  "request_refund",
  "revoke_refund",
  "authorize_refund_signed",
  "cosign_refund",
  "dispute_refund",
  "authorize_refund",
  "execute_refund",
  "create_release_intent",
  "approve_release",
  "execute_release",
  "submit_cancel_consent",
  "revoke_cancel_consent",
  "abandon_release_intent",
  "propose_destination_change",
  "consent_destination_change",
  "revoke_destination_change",
  "activate_destination_change",
  "propose_key_rebinding",
  "consent_key_rebinding",
  "revoke_key_rebinding",
  "activate_key_rebinding",
  "approve_asset_recovery",
  "execute_asset_recovery",
]);

const MAX_BODY = 256 * 1024;
const MAX_GAS = 300_000_000_000_000n;

export interface RelayStatus {
  readonly relayer: string;
  readonly contractId: string;
  readonly network: string;
  readonly chain: string;
  readonly note: string;
}

export interface PartyRelayOptions {
  readonly escrowId: string;
  /** The web origin; a request carrying another Origin is refused. */
  readonly origin: string;
  readonly status: RelayStatus;
  readonly submit: (call: FunctionCall) => Promise<RelayResult>;
  readonly perMinute?: number;
  readonly log?: (line: Record<string, string | number | null>) => void;
}

class RelayRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Validates a call from the browser; returns the exact call to sign or throws a refusal. */
export function relayableCall(raw: unknown, escrowId: string): FunctionCall {
  const c = raw as Partial<Record<keyof FunctionCall, unknown>> | null;
  if (typeof c !== "object" || c === null || Array.isArray(c))
    throw new RelayRefusal(400, "VALIDATION_FAILED", "call must be an object");
  const keys = Object.keys(c).sort().join(",");
  if (keys !== "args,depositYocto,gas,methodName,receiverId")
    throw new RelayRefusal(
      400,
      "VALIDATION_FAILED",
      "call must have exactly receiverId, methodName, args, gas, depositYocto",
    );
  if (c.receiverId !== escrowId)
    throw new RelayRefusal(403, "WRONG_CONTRACT", "this relayer submits calls to the configured escrow only");
  if (typeof c.methodName !== "string" || !RELAYABLE_METHODS.has(c.methodName))
    throw new RelayRefusal(
      403,
      "FORBIDDEN",
      "this method is not relayed: the party's own wallet sends it (for example fund)",
    );
  if (c.depositYocto !== "0")
    throw new RelayRefusal(
      403,
      "INVALID_AMOUNT",
      "relayed calls carry no deposit; the party's own wallet sends deposits",
    );
  if (typeof c.gas !== "string" || !/^[1-9][0-9]{0,15}$/.test(c.gas) || BigInt(c.gas) > MAX_GAS)
    throw new RelayRefusal(400, "VALIDATION_FAILED", "gas must be a positive integer up to 300 Tgas");
  if (typeof c.args !== "object" || c.args === null || Array.isArray(c.args))
    throw new RelayRefusal(400, "VALIDATION_FAILED", "args must be a JSON object");
  return {
    receiverId: c.receiverId,
    methodName: c.methodName,
    args: c.args as Record<string, unknown>,
    gas: c.gas,
    depositYocto: "0",
  };
}

export class PartyRelay {
  private server: Server | null = null;
  private window: { start: number; count: number } = { start: 0, count: 0 };

  constructor(private readonly o: PartyRelayOptions) {}

  private send(res: ServerResponse, status: number, body: unknown): void {
    const s = JSON.stringify(body);
    res
      .writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      })
      .end(s);
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new RelayRefusal(413, "LIMIT_EXCEEDED", "request body too large");
      chunks.push(c as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RelayRefusal(400, "MALFORMED_JSON", "body is not JSON");
    }
  }

  private allow(): boolean {
    const now = Date.now();
    if (now - this.window.start >= 60_000) this.window = { start: now, count: 0 };
    this.window.count += 1;
    return this.window.count <= (this.o.perMinute ?? 60);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://relay");
    try {
      if (req.method === "GET" && url.pathname === "/relay/v1/status")
        return this.send(res, 200, this.o.status);
      if (req.method === "POST" && url.pathname === "/relay/v1/calls") {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== this.o.origin)
          throw new RelayRefusal(403, "WRONG_ORIGIN", "request origin is not the web origin");
        if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
          throw new RelayRefusal(415, "VALIDATION_FAILED", "content-type must be application/json");
        if (!this.allow())
          throw new RelayRefusal(429, "RATE_LIMITED", "too many relayed calls; try again shortly");
        const b = (await this.body(req)) as { call?: unknown } | null;
        const call = relayableCall(b?.call, this.o.escrowId);
        const r = await this.o.submit(call);
        this.o.log?.({ event: "relay.submitted", method: r.method, outcome: r.outcome, txHash: r.txHash });
        return this.send(res, 200, r);
      }
      return this.send(res, 404, { error: "NOT_FOUND: no such relay route" });
    } catch (e) {
      if (e instanceof RelayRefusal) return this.send(res, e.status, { error: `${e.code}: ${e.message}` });
      const code = e instanceof DocksideError ? e.code : "INTERNAL";
      // Code, message and detail codes only (DocksideError details never carry key material).
      const detail = e instanceof DocksideError ? JSON.stringify(e.details) : null;
      this.o.log?.({ event: "relay.error", code, message: (e as Error).message ?? null, detail });
      return this.send(res, e instanceof DocksideError ? e.httpStatus : 500, {
        error: `${code}: relay failed`,
      });
    }
  }

  async listen(port: number): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.requestTimeout = 120_000;
    // Loopback only: the web server proxies /relay; nothing else reaches it.
    await new Promise<void>((r) => this.server?.listen(port, "127.0.0.1", r));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const s = this.server;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
}
