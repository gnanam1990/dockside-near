/**
 * Dockside LOCAL STACK — the real API process wired to a SIMULATED NEAR chain, for running the
 * web UI end to end on one machine. It is not a deployment and never touches testnet.
 *
 * What runs here, and what is real:
 * - Real: the control API (`createApp` from services/api, the same code `pnpm run api` serves)
 *   with every trade module (EvidenceService, HoldService, ReleaseService, JournalService) on a
 *   fresh SQLite file, the production JSON-RPC NEAR client, the M05 outbox worker and reconciler,
 *   the ManifestAttestor and deterministic-policy services holding their keys in isolated signer
 *   child processes, and organisation administrators who act through the authority service.
 * - Simulated: the chain. The compiled escrow wasm runs on the M02 host behind the M05 JSON-RPC
 *   server (packages/journal/test/sim-chain.ts). The "relayer" and the "funding wallet" below sign
 *   simulated transaction envelopes with no keys, exactly as the M05 tests do.
 *
 * Human trade roles (buyer approver, supplier signer, inspector, risk/policy resolver) are NOT
 * created here: each is invited by its organisation's administrator and accepts in its own
 * browser session with its own non-extractable device key (the control API below only issues
 * the invitation and, later, the administrator's grant).
 *
 * Ports: API on DOCKSIDE_STACK_API_PORT (default 8791; serves /v1, /healthz, /readyz), control
 * and relayer on DOCKSIDE_STACK_CONTROL_PORT (default 8792; /relay/v1/* is what the web preview
 * proxies to the browser, /control/* is for the operator and the browser tests only).
 *
 * Run: pnpm run build && pnpm run contract:build && pnpm run stack
 */
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, hardenServer } from "@dockside/api";
import { type AuthContext, AuthorityService, IsolatedSigner } from "@dockside/authority";
import {
  type Capability,
  generateEd25519KeyPair,
  loadConfig,
  randomIds,
  sha256,
  signFor,
  systemClock,
  toHex,
  toTypedJson,
} from "@dockside/core";
import { EvidenceService, HoldService, LocalObjectStore } from "@dockside/evidence";
import { Journal, JournalService, OutboxWorker, Reconciler } from "@dockside/journal";
import { EscrowContract, type FunctionCall, JsonRpcNearClient, NearTxClient } from "@dockside/near";
import { ReleaseService } from "@dockside/release";
import { Database } from "@dockside/store";
import { WorkerLoop } from "@dockside/worker";
import { SimChainServer, SimTxSigner } from "../../packages/journal/test/sim-chain.js";
import { NearSim } from "../../packages/near/test/sim/near-sim.js";

const env = process.env;
const API_PORT = Number(env["DOCKSIDE_STACK_API_PORT"] ?? 8791);
const CONTROL_PORT = Number(env["DOCKSIDE_STACK_CONTROL_PORT"] ?? 8792);
const ORIGIN = env["DOCKSIDE_ORIGIN"] ?? "http://127.0.0.1:4391";
const HOST = "127.0.0.1";

export const CONTRACT = "dockside-escrow.testnet";
export const BUYER_ACCT = "acme-buyer.testnet";
export const TREASURY = "treasury-acme.testnet";
export const SUPPLIER_ACCT = "harbor-supplier.testnet";
/** A second supplier-owned account, the target of a legitimate destination change. */
export const SUPPLIER_ALT_ACCT = "harbor-payouts.testnet";
const WORKER_RELAYER = "relayer.testnet";
const PARTY_RELAYER = "party-relayer.testnet";
const NEAR = 10n ** 24n;
const DAY = 24 * 3600_000;

const log = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);

/* ------------------------------ evidence policy ------------------------------ */

function slot(slotId: string, issuer: string, uploaders: string[], freshnessMs: number) {
  return {
    schema: "dockside/evidence-slot-policy@1" as const,
    slotId,
    purpose: `${slotId} for the milestone`,
    minItems: 1,
    maxItems: 1,
    allowedMime: ["application/pdf", "text/plain"],
    contentClass: "DOCUMENT",
    maxItemBytes: 65_536,
    maxAggregateBytes: 65_536,
    limits: {
      maxPages: 20,
      maxPixels: 4_000_000,
      maxDecompressedBytes: 1_048_576,
      maxDecompressionRatioPermille: 100_000,
      maxParseTimeMs: 2_000,
    },
    parserProfiles: ["dockside-sniff@1"],
    uploaderCapabilities: uploaders,
    issuerCapabilities: [issuer],
    issuedAtRequired: true,
    freshnessMs,
    replacement: "SUPERSEDE_CURRENT" as const,
    requiredDerived: [{ artifactClass: "TEXT_EXTRACT", transformProfile: "dockside-text@1" }],
  };
}

/** The organisation's registered EvidencePolicy (same shape as the M03 commercial policy). */
const POLICY = {
  schema: "dockside/evidence-policy@1" as const,
  policyId: "commercial-docs",
  revision: 1,
  attestationLifetimeMs: DAY,
  slots: [
    slot("commercial-invoice", "SUPPLIER_SIGNER", ["SUPPLIER_SIGNER", "EVIDENCE_UPLOADER"], 30 * DAY),
    slot("inspection-report", "INSPECTOR", ["INSPECTOR"], 7 * DAY),
    {
      ...slot("cargo-photos", "INSPECTOR", ["INSPECTOR", "BUYER_APPROVER"], 30 * DAY),
      allowedMime: ["image/png", "image/jpeg"],
      contentClass: "IMAGE",
      maxItems: 2,
      maxAggregateBytes: 100_000,
      requiredDerived: [{ artifactClass: "IMAGE_METADATA", transformProfile: "dockside-image-meta@1" }],
    },
  ],
};

/* ------------------------------- administrators ------------------------------- */

/** An organisation security administrator: own key, real PoP bootstrap, per-request proofs. */
class Admin {
  readonly key = generateEd25519KeyPair();
  grant!: { sessionId: string; sessionToken: string; principalId: string; organizationId: string };
  constructor(
    private readonly svc: AuthorityService,
    readonly organizationName: string,
  ) {
    const c = svc.createBootstrapChallenge({ organizationName, publicKey: this.key.publicKey });
    this.grant = svc.completeBootstrap({
      challengeId: c.challengeId,
      proof: {
        scheme: "dockside-ed25519",
        signature: signFor(this.key.privateKey, "POP_CHALLENGE", c.canonicalPayload),
      },
    });
  }
  ctx(): AuthContext {
    const method = "POST";
    const path = "/v1/admin";
    const body = "{}";
    const issuedAt = Date.now();
    const nonce = toHex(sha256(new TextEncoder().encode(`${randomIds.next("cor")}${Math.random()}`)));
    const payload = {
      sessionId: this.grant.sessionId,
      origin: ORIGIN,
      method,
      path,
      bodyDigest: toHex(sha256(new TextEncoder().encode(body))),
      issuedAt,
      nonce,
    };
    return this.svc.authenticate({
      sessionToken: this.grant.sessionToken,
      proof: {
        sessionId: this.grant.sessionId,
        issuedAt,
        nonce,
        signature: signFor(this.key.privateKey, "REQUEST_PROOF", payload),
      },
      method,
      path,
      body,
    });
  }
}

/* ------------------------------------ main ------------------------------------ */

async function main(): Promise<void> {
  const dir = env["DOCKSIDE_STACK_DATA_DIR"] ?? mkdtempSync(join(tmpdir(), "dockside-stack-"));

  // Simulated chain: compiled escrow wasm on the M02 host, served over JSON-RPC.
  // Simulated chain time = wall clock + an offset that only moves forward (see /control/chain-time).
  let chainOffsetMs = 0;
  const chainNow = () => Date.now() + chainOffsetMs;
  const sim = new NearSim(CONTRACT, chainNow());
  for (const a of [BUYER_ACCT, TREASURY, SUPPLIER_ACCT, SUPPLIER_ALT_ACCT, WORKER_RELAYER, PARTY_RELAYER])
    sim.credit(a, 1000n * NEAR);
  if (!sim.call("new", { network: "near-testnet", min_deposit_yocto: null }, { predecessor: CONTRACT }).ok)
    throw new Error("escrow init failed");
  const chain = new SimChainServer(sim, chainNow, { validityBlocks: 100 });
  const rpcUrl = await chain.start();
  const blocks = setInterval(() => chain.advanceBlocks(1), 1000);
  // Fault switch for whole-chain receipt hiding (a pruned/private node); off by default.
  let hideAllReceipts = false;
  const hidden = chain.faults.hideReceipts;
  chain.faults.hideReceipts = new Proxy(hidden, {
    get(target, prop, receiver) {
      if (prop === "has") return (h: string) => hideAllReceipts || target.has(h);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const config = loadConfig({
    DOCKSIDE_DB_PATH: join(dir, "dockside.sqlite"),
    DOCKSIDE_ORIGIN: ORIGIN,
    DOCKSIDE_HOST: HOST,
    DOCKSIDE_PORT: String(API_PORT),
    DOCKSIDE_NETWORK: "near-testnet",
    DOCKSIDE_ESCROW_CONTRACT_ID: CONTRACT,
    DOCKSIDE_NEAR_RPC_URL: rpcUrl,
    DOCKSIDE_OBJECT_STORE_DIR: join(dir, "objects"),
    // The browser tests shorten the destination-change delay new proposals bind (never below 1 minute).
    ...(env["DOCKSIDE_DESTINATION_CHANGE_DELAY_MS"]
      ? { DOCKSIDE_DESTINATION_CHANGE_DELAY_MS: env["DOCKSIDE_DESTINATION_CHANGE_DELAY_MS"] }
      : {}),
  });
  const db = Database.open(config.DOCKSIDE_DB_PATH);
  db.migrate();
  const authority = new AuthorityService({
    db,
    clock: systemClock,
    ids: randomIds,
    config: {
      origin: config.DOCKSIDE_ORIGIN,
      network: config.DOCKSIDE_NETWORK,
      challengeTtlMs: config.DOCKSIDE_CHALLENGE_TTL_MS,
      sessionTtlMs: config.DOCKSIDE_SESSION_TTL_MS,
      invitationTtlMs: config.DOCKSIDE_INVITATION_TTL_MS,
      recoveryDelayMs: config.DOCKSIDE_RECOVERY_DELAY_MS,
      requestProofSkewMs: config.DOCKSIDE_REQUEST_PROOF_SKEW_MS,
    },
  });
  const rpc = () =>
    new JsonRpcNearClient({
      endpoint: rpcUrl,
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 5_000,
      maxResponseBytes: 4 * 1024 * 1024,
    });
  // Trade modules exactly as services/api/src/main.ts wires them.
  const escrow = new EscrowContract(rpc(), CONTRACT);
  const deps = { db, clock: systemClock, ids: randomIds, authority };
  const evidence = new EvidenceService({
    ...deps,
    objects: new LocalObjectStore(config.DOCKSIDE_OBJECT_STORE_DIR, `stack-${process.pid}`),
  });
  const holds = new HoldService({ ...deps, evidence });
  const release = new ReleaseService({ ...deps, evidence, holds, escrow });
  const journal = new JournalService({ db, clock: systemClock, ids: randomIds, escrow, release });

  /* Organisations, services and policy (administrator actions through the authority service). */
  const admins = {
    buyer: new Admin(authority, "Acme Imports"),
    supplier: new Admin(authority, "Harbor Supply"),
    inspector: new Admin(authority, "Port Inspections"),
  };
  const enroll = async (capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET", serviceId: string) => {
    const purpose = capability === "MANIFEST_ATTEST" ? "MANIFEST_ATTESTATION" : "HOLD_SET";
    const signer = await IsolatedSigner.spawn({ allowedPurposes: ["SERVICE_POP_CHALLENGE", purpose] });
    const e = authority.createServiceEnrollment(admins.buyer.ctx(), {
      serviceId,
      capability,
      publicKey: signer.publicKey,
      scope: { tradeId: null, evidencePolicyId: POLICY.policyId, evidencePolicyRevision: POLICY.revision },
      custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: `signer://${serviceId}/v1` },
    });
    authority.proveServiceKey({
      challengeId: e.challenge.challengeId,
      signature: await signer.sign("SERVICE_POP_CHALLENGE", e.challenge.canonicalPayload),
    });
    authority.activateServiceKey(admins.buyer.ctx(), { enrollmentId: e.enrollmentId, keyVersion: 1 });
    return { signer, enrollmentId: e.enrollmentId };
  };
  const attestor = await enroll("MANIFEST_ATTEST", "manifest-attestor");
  const policy = await enroll("DETERMINISTIC_POLICY_SET", "deterministic-policy");
  evidence.registerPolicy(POLICY);

  /* Relaying: signs simulated envelopes (no keys) and broadcasts through the production client. */
  const tx = new NearTxClient(rpc());
  let queue: Promise<unknown> = Promise.resolve();
  const submit = (signerId: string, call: FunctionCall) => {
    const run = async () => {
      if (call.receiverId !== CONTRACT)
        throw Object.assign(new Error("receiver"), { code: "WRONG_RECEIVER" });
      const signer = new SimTxSigner(signerId);
      const block = await tx.latestBlock();
      const nonce = (await tx.accessKeyNonce(signerId, signer.publicKey).catch(() => 0n)) + 1n;
      const signed = await signer.sign(call, { nonce, blockHash: block.hash });
      const out = await tx.send(signed);
      return {
        txHash: signed.txHash,
        outcome: out.kind,
        error: out.kind === "NOT_FOUND" ? null : out.error,
        method: call.methodName,
      };
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  };

  /* ManifestAttestor service: attests each complete, unattested manifest and keeps the chain current. */
  const attestorLoop = setInterval(() => {
    void (async () => {
      for (const r of db.all("SELECT trade_id FROM evidence_trades")) {
        const t = String(r["trade_id"]);
        try {
          const terms = evidence.terms(t);
          if (terms.manifestAttestor.publicKey !== attestor.signer.publicKey) continue;
          if (evidence.evaluate(t).status !== "COMPLETE") continue;
          if ((await escrow.getTrade(t)) === null) continue;
          let att = evidence.currentAttestation(t);
          if (!att) att = await evidence.attest(t, attestor.signer);
          const onChain = await escrow.getEvidence(t);
          if (onChain.current?.digest === att.manifestDigest) continue;
          const res = await submit(
            WORKER_RELAYER,
            escrow.submitManifestAttestationCall(t, att.typed, att.signature),
          );
          log({ event: "attestor.submitted", tradeId: t, outcome: res.outcome });
        } catch (e) {
          log({ event: "attestor.error", tradeId: t, code: (e as { code?: string }).code ?? "INTERNAL" });
        }
      }
    })();
  }, 1000);

  /* Deterministic-policy service: evaluates its versioned rules when a trade's evidence state changes. */
  const evaluated = new Map<string, string>();
  const policyLoop = setInterval(() => {
    void (async () => {
      for (const r of db.all("SELECT trade_id FROM evidence_trades")) {
        const t = String(r["trade_id"]);
        try {
          const terms = evidence.terms(t);
          if (terms.policySetter.publicKey !== policy.signer.publicKey) continue;
          const key = `${evidence.currentInspection(t)?.digest ?? "-"}|${evidence.currentAcceptedManifestDigest(t) ?? "-"}`;
          if (evaluated.get(t) === key) continue;
          evaluated.set(t, key);
          for (const h of await holds.applyDeterministicPolicy(t, policy.signer)) {
            const res = await submit(
              WORKER_RELAYER,
              escrow.setHoldCall(t, toTypedJson(h.setPayload), h.setSignature),
            );
            log({ event: "policy.hold_set", tradeId: t, ruleId: h.ruleId, outcome: res.outcome });
          }
        } catch (e) {
          log({ event: "policy.error", tradeId: t, code: (e as { code?: string }).code ?? "INTERNAL" });
        }
      }
    })();
  }, 1000);

  /* M05 outbox worker and reconciler (journal engines over the production NEAR clients). */
  const ports = {
    escrow: new EscrowContract(rpc(), CONTRACT),
    tx: new NearTxClient(rpc()),
    txValidityBlocks: 100,
  };
  const engineCfg = {
    holder: "stack-worker",
    leaseTtlMs: 30_000,
    baseBackoffMs: 500,
    maxBackoffMs: 2_000,
    watchMs: DAY,
  };
  const wj = new Journal(db, systemClock, randomIds);
  const reconciler = new Reconciler(wj, ports, engineCfg);
  const worker = new WorkerLoop({
    worker: new OutboxWorker(wj, ports, new SimTxSigner(WORKER_RELAYER), reconciler, engineCfg),
    reconciler,
    intervalMs: 500,
    log,
  });
  worker.start();

  /* The API itself. */
  const api = hardenServer(
    createServer(
      createApp({
        config,
        db,
        authority,
        clock: systemClock,
        ids: randomIds,
        log,
        modules: { evidence, holds, release, journal, escrow },
      }),
    ),
  );
  await new Promise<void>((r) => api.listen(API_PORT, HOST, r));

  /* Control + relayer. */
  const json = (res: ServerResponse, status: number, body: unknown) => {
    const s = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString(10) : v));
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(s);
  };
  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };
  const adminOf = (org: unknown): Admin => {
    if (org === "buyer" || org === "supplier" || org === "inspector") return admins[org];
    throw Object.assign(new Error("org must be buyer, supplier or inspector"), { code: "VALIDATION_FAILED" });
  };
  const control = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stack");
      try {
        if (req.method === "GET" && url.pathname === "/relay/v1/status")
          return json(res, 200, {
            relayer: PARTY_RELAYER,
            contractId: CONTRACT,
            network: "near-testnet",
            chain: "SIMULATED",
            note: "Local stack: compiled escrow wasm on a simulated NEAR host. Not testnet.",
          });
        if (req.method === "POST" && url.pathname === "/relay/v1/calls") {
          const b = await readBody(req);
          return json(res, 200, await submit(PARTY_RELAYER, b["call"] as FunctionCall));
        }
        if (req.method === "GET" && url.pathname === "/control/info")
          return json(res, 200, {
            contractId: CONTRACT,
            accounts: {
              buyer: BUYER_ACCT,
              treasury: TREASURY,
              supplier: SUPPLIER_ACCT,
              supplierAlt: SUPPLIER_ALT_ACCT,
            },
            destinationChangeDelayMs: config.DOCKSIDE_DESTINATION_CHANGE_DELAY_MS,
            chainOffsetMs,
            organizations: Object.fromEntries(
              Object.entries(admins).map(([k, a]) => [
                k,
                { organizationId: a.grant.organizationId, name: a.organizationName },
              ]),
            ),
            services: { manifestAttestor: attestor.enrollmentId, deterministicPolicy: policy.enrollmentId },
            evidencePolicy: { id: POLICY.policyId, revision: POLICY.revision },
          });
        if (req.method === "POST" && url.pathname === "/control/invitations") {
          const b = await readBody(req);
          const inv = authority.createInvitation(adminOf(b["org"]).ctx(), {
            capability: b["capability"] as Capability,
          });
          return json(res, 201, { invitationId: inv.invitationId, secret: inv.secret });
        }
        if (req.method === "POST" && url.pathname === "/control/grants") {
          const b = await readBody(req);
          return json(
            res,
            201,
            authority.grantRole(adminOf(b["org"]).ctx(), { invitationId: String(b["invitationId"]) }),
          );
        }
        if (req.method === "POST" && url.pathname === "/control/fund") {
          // A funder's wallet sends the deposit itself (predecessor = funder account).
          const b = await readBody(req);
          const from = String(b["from"] ?? BUYER_ACCT);
          const call = escrow.fundCall(String(b["tradeId"]), BigInt(String(b["amountYocto"])));
          return json(res, 200, await submit(from, call));
        }
        if (req.method === "POST" && url.pathname === "/control/funder-call") {
          // The original funder's simulated wallet submits a refund call the API prepared for it
          // (request_refund / revoke_refund for PARTIAL_ or EXCESS_FUNDING_RETURN). The contract
          // checks that the transaction signer is the recorded funder.
          const b = await readBody(req);
          const call = b["call"] as FunctionCall;
          if (!["request_refund", "revoke_refund"].includes(String(call?.methodName)))
            throw Object.assign(new Error("only refund calls go through a funder wallet"), {
              code: "VALIDATION_FAILED",
            });
          return json(res, 200, await submit(String(b["from"]), call));
        }
        if (req.method === "POST" && url.pathname === "/control/chain-time") {
          // Simulated chain only: block time moves forward so a contract timelock can elapse in a
          // test. The API, worker and sessions keep the wall clock; a real chain cannot do this.
          const b = await readBody(req);
          const ms = Number(b["advanceMs"]);
          if (!Number.isInteger(ms) || ms <= 0 || ms > 7 * DAY)
            throw Object.assign(new Error("advanceMs must be a positive integer up to 7 days"), {
              code: "VALIDATION_FAILED",
            });
          chainOffsetMs += ms;
          log({ event: "chain.time_advanced", advanceMs: ms, chainOffsetMs });
          return json(res, 200, { chainOffsetMs, chainNowMs: chainNow() });
        }
        if (req.method === "POST" && url.pathname === "/control/faults") {
          const b = await readBody(req);
          if (typeof b["statusDown"] === "boolean") chain.faults.statusDown = b["statusDown"];
          if (typeof b["down"] === "boolean") chain.faults.down = b["down"];
          if (typeof b["dropSendResponses"] === "number")
            chain.faults.dropSendResponses = b["dropSendResponses"];
          if (typeof b["hideAllReceipts"] === "boolean") hideAllReceipts = b["hideAllReceipts"];
          return json(res, 200, { ...chain.faults, hideReceipts: undefined, hideAllReceipts });
        }
        return json(res, 404, { error: { code: "NOT_FOUND", message: "no such control route" } });
      } catch (e) {
        const code = (e as { code?: string }).code ?? "INTERNAL";
        return json(res, 400, { error: { code, message: (e as Error).message } });
      }
    })();
  });
  await new Promise<void>((r) => control.listen(CONTROL_PORT, HOST, r));
  log({
    event: "stack.listening",
    api: `http://${HOST}:${API_PORT}`,
    control: `http://${HOST}:${CONTROL_PORT}`,
    origin: ORIGIN,
    chain: "SIMULATED",
  });

  const stop = () => {
    clearInterval(blocks);
    clearInterval(attestorLoop);
    clearInterval(policyLoop);
    void worker.stop().finally(() => {
      attestor.signer.close();
      policy.signer.close();
      api.close();
      control.close();
      void chain.stop().finally(() => {
        db.close();
        process.exit(0);
      });
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main().catch((e) => {
  process.stderr.write(`stack failed: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
