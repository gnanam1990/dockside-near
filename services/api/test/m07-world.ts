/**
 * M07 test world: the M05 journal world (separately enrolled principals through the real M01
 * flows, isolated attestor and deterministic-policy signer processes, compiled escrow wasm on the
 * simulated NEAR host served over HTTP JSON-RPC) behind the real node:http API on an ephemeral
 * port. Every request below is a real HTTP request carrying the actor's own session token and a
 * fresh Ed25519 request proof; relay calls returned by the API are executed against the
 * simulated contract exactly as returned.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CanonicalValue,
  fromTypedJson,
  loadConfig,
  randomIds,
  type SigningPurpose,
  signFor,
  type TypedJson,
} from "@dockside/core";
import { AssetRecoveryJournal } from "@dockside/journal";
import { type FunctionCall, NearTxClient, Nep141Reader } from "@dockside/near";
import { expect } from "vitest";
import { type Actor, bootstrap, enrollHuman, ORIGIN } from "../../../packages/authority/test/helpers.js";
import { fillAll } from "../../../packages/evidence/test/world.js";
import { type JWorld, jworld, rpcFor, run } from "../../../packages/journal/test/world.js";
import { createApp } from "../src/app.js";

export interface Res {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export interface Actors {
  buyer: Actor;
  supplier: Actor;
  inspector: Actor;
  risk: Actor;
  auditor: Actor;
  buyerAdmin: Actor;
  supplierAdmin: Actor;
  supplierClerk: Actor;
  outsiderClerk: Actor;
  otherInspector: Actor;
  outsiderAdmin: Actor;
  [role: string]: Actor;
}

export interface ApiWorld {
  w: JWorld;
  base: string;
  logs: string[];
  auditor: Actor;
  /** Each actor by role name, for matrix tests. */
  actors: Actors;
  http(
    a: Actor | null,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Res>;
  relay(res: Res, predecessor?: string): void;
  relayExpectFail(res: Res, predecessor?: string): string;
  sign(a: Actor, purpose: SigningPurpose, typed: TypedJson): string;
  close(): Promise<void>;
}

export async function apiWorld(opts: { funded?: boolean; evidence?: boolean } = {}): Promise<ApiWorld> {
  const w = await jworld(opts);
  const c = w.c;
  const h = c.w.h;
  const auditor = enrollHuman(h, c.w.buyerAdmin, "AUDITOR");
  const outsiderAdmin = bootstrap(h, "Elsewhere Freight");
  const logs: string[] = [];
  const config = loadConfig({ DOCKSIDE_DB_PATH: h.dbPath, DOCKSIDE_ORIGIN: ORIGIN });
  const server: Server = createServer(
    createApp({
      config,
      db: h.db,
      authority: h.svc,
      clock: h.clock,
      ids: randomIds,
      log: (line) => logs.push(JSON.stringify(line)),
      modules: {
        evidence: c.w.evidence,
        holds: c.w.holds,
        release: c.rel,
        journal: w.svc,
        escrow: c.escrow,
        // M11: token views and transaction lookups go through the simulated chain's JSON-RPC.
        assetRecovery: {
          journal: new AssetRecoveryJournal(h.db, h.clock, randomIds),
          token: (contract: string) => new Nep141Reader(rpcFor(w.url), contract),
          tx: new NearTxClient(rpcFor(w.url)),
        },
      },
    }),
  );
  const base = await new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
  const toCall = (res: Res): FunctionCall => {
    expect(res.status, res.text).toBeLessThan(300);
    const call = res.json.relay as FunctionCall;
    expect(call.receiverId).toBe(c.escrow.contractId);
    return call;
  };
  const api: ApiWorld = {
    w,
    base,
    logs,
    auditor,
    actors: {
      buyer: c.w.buyer,
      supplier: c.w.supplier,
      inspector: c.w.inspector,
      risk: c.w.risk,
      auditor,
      buyerAdmin: c.w.buyerAdmin,
      supplierAdmin: c.w.supplierAdmin,
      supplierClerk: c.w.supplierClerk,
      outsiderClerk: c.w.outsiderClerk,
      otherInspector: c.w.otherInspector,
      outsiderAdmin,
    },
    async http(a, method, path, body, headers = {}) {
      const raw = body === undefined ? (method === "POST" ? "{}" : "") : JSON.stringify(body);
      const hdr: Record<string, string> = { ...headers };
      if (method === "POST") hdr["content-type"] = "application/json";
      if (a?.grant) {
        hdr["authorization"] = `Dockside-Session ${a.grant.sessionToken}`;
        hdr["dockside-proof"] = Buffer.from(JSON.stringify(a.proof(method, path, raw))).toString("base64url");
      }
      const init: RequestInit = { method, headers: hdr };
      if (method === "POST") init.body = raw;
      const res = await fetch(base + path, init);
      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text, headers: res.headers };
    },
    relay(res, predecessor) {
      c.ok(toCall(res), predecessor);
    },
    relayExpectFail(res, predecessor) {
      const r = c.exec(toCall(res), predecessor);
      expect(r.ok).toBe(false);
      return r.error ?? "";
    },
    sign(a, purpose, typed) {
      return signFor(a.key.privateKey, purpose, fromTypedJson(typed) as CanonicalValue);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await w.close();
    },
  };
  return api;
}

/** Buyer locks an intent and approves it over HTTP; every relay goes to the contract. */
export async function lockAndApprove(a: ApiWorld, key = "api-intent-0001"): Promise<string> {
  const { buyer } = a.actors as { buyer: Actor };
  const t = a.w.c.t;
  const prep = await a.http(buyer, "POST", `/v1/trades/${t}/release-intents`, { idempotencyKey: key });
  expect(prep.status, prep.text).toBe(201);
  const id = prep.json.releaseIntentId as string;
  const signed = await a.http(buyer, "POST", `/v1/release-intents/${id}/signature`, {
    signature: a.sign(buyer, "RELEASE_INTENT", prep.json.payload),
  });
  a.relay(signed);
  expect((await a.http(buyer, "POST", `/v1/trades/${t}/sync`)).status).toBe(201);
  const ch = await a.http(buyer, "POST", `/v1/release-intents/${id}/approval-challenges`);
  expect(ch.status, ch.text).toBe(201);
  const ap = await a.http(buyer, "POST", `/v1/release-intents/${id}/approval`, {
    payload: ch.json.payload,
    signature: a.sign(buyer, "BUYER_APPROVAL", ch.json.payload),
  });
  a.relay(ap);
  await a.http(buyer, "POST", `/v1/trades/${t}/sync`);
  return id;
}

/** The bound risk/policy resolver SETs a hold over HTTP and relays it to the contract. */
export async function riskHold(a: ApiWorld, ttlMs = 2 * 3600_000): Promise<string> {
  const risk = a.actors["risk"] as Actor;
  const t = a.w.c.t;
  const ch = await a.http(risk, "POST", `/v1/trades/${t}/hold-challenges`, {
    reasonCode: "SANCTIONS_REVIEW",
    ttlMs,
  });
  expect(ch.status, ch.text).toBe(201);
  const set = await a.http(risk, "POST", `/v1/trades/${t}/holds`, {
    payload: ch.json.payload,
    signature: a.sign(risk, "HOLD_SET", ch.json.payload),
  });
  a.relay(set);
  return set.json.hold.holdId as string;
}

export { fillAll, run };
