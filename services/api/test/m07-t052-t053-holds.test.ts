/**
 * T-053 (integrated API denies release under hold) and T-052 (only the risk/policy principal
 * resolves a hold) at the real HTTP boundary, the service boundary and the compiled contract
 * (simulated NEAR host). Every denial is checked for "nothing happened": no economic operation,
 * no stored idempotent success, no hold resolution row.
 */
import { generateEd25519KeyPair, newNonce, signFor, toTypedJson } from "@dockside/core";
import { holdResolvePayload, tradeBinding } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/authority/test/helpers.js";
import { panicCode } from "../../../packages/release/test/chain.js";
import { type ApiWorld, apiWorld, lockAndApprove, run } from "./m07-world.js";

const DENIALS = ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "KEY_NOT_BOUND"];
const count = (a: ApiWorld, table: string) =>
  Number(a.w.c.w.h.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.["n"] ?? 0);

async function policyHold(a: ApiWorld, ttlMs: number, reasonCode = "DOC_MISMATCH"): Promise<string> {
  const c = a.w.c;
  const hold = await c.w.holds.setByPolicy(
    c.t,
    { ruleId: "doc-mismatch@1", reasonCode, ttlMs },
    c.w.policySigner,
  );
  c.ok(c.escrow.setHoldCall(c.t, toTypedJson(hold.setPayload), hold.setSignature));
  return hold.id;
}

describe("T-053: every API release path stays denied under ACTIVE and EXPIRED_UNRESOLVED holds", () => {
  let a: ApiWorld;
  let intentId = "";
  let holdId = "";
  beforeAll(async () => {
    a = await apiWorld();
    intentId = await lockAndApprove(a, "hold-intent-0001");
    holdId = await policyHold(a, 5 * 60_000);
  });
  afterAll(async () => {
    await a.close();
  });

  const attempt = async (phase: string) => {
    const t = a.w.c.t;
    const roles = Object.entries(a.actors) as [string, Actor | null][];
    roles.push(["unauthenticated", null]);
    const before = count(a, "economic_operations");
    for (const [role, actor] of roles) {
      for (const key of [undefined, `replay-${phase}-${role}`.slice(0, 64)]) {
        const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
        for (let i = 0; i < (key ? 2 : 1); i++) {
          const res = await a.http(actor, "POST", `/v1/release-intents/${intentId}/execute`, {}, headers);
          expect(res.status, `${phase} ${role}`).toBeGreaterThanOrEqual(400);
          const code = res.json.error.code as string;
          if (role === "buyer") expect(code, `${phase} buyer`).toBe("HOLD_ACTIVE");
          else expect(DENIALS, `${phase} ${role}: ${code}`).toContain(code);
        }
      }
      // Approval and new intents are no side door either.
      const appr = await a.http(actor, "POST", `/v1/release-intents/${intentId}/approval-challenges`);
      expect(appr.status).toBeGreaterThanOrEqual(400);
      const fresh = await a.http(actor, "POST", `/v1/trades/${t}/release-intents`, {
        idempotencyKey: `x-${phase}-${role}`,
      });
      expect(fresh.status).toBeGreaterThanOrEqual(400);
    }
    // A client-side "force" or UI flag is not part of any schema.
    const flagged = await a.http(
      a.actors["buyer"] as Actor,
      "POST",
      `/v1/release-intents/${intentId}/execute`,
      {
        force: true,
        releaseReady: true,
      },
    );
    expect(["UNKNOWN_FIELD", "VALIDATION_FAILED"]).toContain(flagged.json.error.code);
    expect(count(a, "economic_operations")).toBe(before);
    expect(
      a.w.c.w.h.db.get("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idem_key LIKE 'replay-%'")?.["n"],
    ).toBe(0);
    // Projection, service and contract agree: the hold blocks.
    const view = await a.http(a.actors["supplier"] as Actor, "GET", `/v1/trades/${t}`);
    expect(view.json.release.blockers).toContain("HOLD_ACTIVE");
    await expect(a.w.svc.enqueueRelease(intentId)).rejects.toMatchObject({ code: "HOLD_ACTIVE" });
    expect(panicCode(a.w.c.exec(a.w.c.escrow.executeReleaseCall(t, intentId), "anyone.testnet"))).toBe(
      "HOLD_ACTIVE",
    );
    // A worker with nothing queued submits nothing.
    await run(a.w, "worker-hold", 2);
    expect(count(a, "economic_operations")).toBe(before);
  };

  it("ACTIVE policy hold: buyer gets HOLD_ACTIVE, everyone else is denied, nothing is queued", async () => {
    const h = await a.http(a.actors["buyer"] as Actor, "GET", `/v1/trades/${a.w.c.t}/holds`);
    expect(h.json.holds[0].status).toBe("ACTIVE");
    await attempt("active");
  });

  it("EXPIRED_UNRESOLVED: expiry never clears the hold at any boundary", async () => {
    a.w.c.w.h.clock.advance(6 * 60_000);
    const h = await a.http(a.actors["buyer"] as Actor, "GET", `/v1/trades/${a.w.c.t}/holds`);
    expect(h.json.holds[0].status).toBe("EXPIRED_UNRESOLVED");
    expect((await a.w.c.escrow.getHolds(a.w.c.t))[0]?.status).toBe("EXPIRED_UNRESOLVED");
    await attempt("expired");
  });

  it("after RESOLVE the old approval is stale; only a fresh intent and approval release (positive control)", async () => {
    const c = a.w.c;
    const t = c.t;
    const { risk, buyer, supplier } = a.actors;
    const ch = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution-challenges`, {
      resolutionCode: "RELEASE_HOLD",
      evidenceDigest: "cd".repeat(32),
    });
    a.relay(
      await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
        payload: ch.json.payload,
        signature: a.sign(risk, "HOLD_RESOLVE", ch.json.payload),
      }),
    );
    const stale = await a.http(buyer, "POST", `/v1/release-intents/${intentId}/execute`);
    expect(stale.status).toBe(409);
    expect(count(a, "economic_operations")).toBe(0);
    // Dual-consent CANCEL over HTTP returns the value; then a fresh intent goes through.
    const cancel = await a.http(supplier, "POST", `/v1/release-intents/${intentId}/cancel-challenges`, {
      reasonCode: "PARTIES_AGREE",
    });
    expect(cancel.status, cancel.text).toBe(201);
    for (const party of [supplier, buyer]) {
      const k = await a.http(party, "POST", `/v1/release-intents/${intentId}/cancel-consent-challenges`, {
        cancel: cancel.json.payload,
      });
      expect(k.status, k.text).toBe(201);
      a.relay(
        await a.http(party, "POST", `/v1/release-intents/${intentId}/cancel-consents`, {
          cancel: cancel.json.payload,
          consent: k.json.payload,
          signature: a.sign(party, "CANCEL_CONSENT", k.json.payload),
        }),
      );
    }
    await a.http(buyer, "POST", `/v1/trades/${t}/sync`);
    const rel = await a.http(buyer, "GET", `/v1/trades/${t}/release`);
    expect(rel.json.intents.find((i: any) => i.releaseIntentId === intentId).state).toBe(
      "CANCELLED_PRE_SUBMIT",
    );
    const next = await lockAndApprove(a, "hold-intent-0002");
    const exec = await a.http(buyer, "POST", `/v1/release-intents/${next}/execute`);
    expect(exec.status, exec.text).toBe(201);
    await run(a.w);
    expect((await a.http(buyer, "GET", `/v1/operations/${exec.json.operationId}`)).json.state).toBe("PAID");
  });
});

describe("T-052: only the current, separately authenticated risk/policy resolver resolves", () => {
  let a: ApiWorld;
  let holdId = "";
  let executorKey = generateEd25519KeyPair();
  beforeAll(async () => {
    a = await apiWorld();
    holdId = await policyHold(a, 3600_000);
    // An EXECUTOR service key enrolled through the real M01 HTTP routes.
    executorKey = generateEd25519KeyPair();
    const admin = a.actors["buyerAdmin"] as Actor;
    const en = await a.http(admin, "POST", "/v1/service-enrollments", {
      serviceId: "payout-executor",
      capability: "EXECUTOR",
      publicKey: executorKey.publicKey,
      scope: { tradeId: null, evidencePolicyId: "commercial-docs", evidencePolicyRevision: 1 },
      custody: { kind: "ISOLATED_SIGNER_PROCESS", reference: "signer://payout-executor/v1" },
    });
    expect(en.status, en.text).toBe(201);
    const proved = await a.http(null, "POST", "/v1/service-enrollments/prove", {
      challengeId: en.json.challenge.challengeId,
      signature: a.sign({ key: executorKey } as Actor, "SERVICE_POP_CHALLENGE", en.json.challenge.payload),
    });
    expect(proved.status, proved.text).toBe(201);
    const act = await a.http(admin, "POST", `/v1/service-enrollments/${en.json.enrollmentId}/activate`, {
      keyVersion: 1,
    });
    expect(act.status, act.text).toBe(201);
  });
  afterAll(async () => {
    await a.close();
  });

  const payload = (over: Record<string, never> = {}) => {
    const c = a.w.c;
    const now = c.w.h.clock.now();
    return toTypedJson(<never>{
      ...(holdResolvePayload(tradeBinding(c.w.evidence.terms(c.t)), {
        holdId,
        holdReasonCode: "DOC_MISMATCH",
        manifestDigest: c.w.evidence.currentAcceptedManifestDigest(c.t),
        resolutionCode: "RELEASE_HOLD",
        evidenceDigest: "ef".repeat(32),
        issuedAt: now,
        expiresAt: now + 3600_000,
        nonce: newNonce(),
      }) as Record<string, never>),
      ...over,
    });
  };

  it("the buyer files and views a review request; it authorizes nothing", async () => {
    const buyer = a.actors["buyer"] as Actor;
    const r = await a.http(buyer, "POST", `/v1/holds/${holdId}/resolution-requests`, {
      note: "goods arrived",
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ authorizing: false, holdStatus: "ACTIVE" });
    const v = await a.http(buyer, "GET", `/v1/trades/${a.w.c.t}/holds`);
    expect(v.json.holds[0].resolutionRequests[0].authorizing).toBe(false);
    expect(count(a, "hold_resolutions")).toBe(0);
    // Nobody but the buyer can file one.
    for (const role of ["supplier", "risk", "inspector", "auditor", "outsiderClerk"]) {
      const x = await a.http(a.actors[role] as Actor, "POST", `/v1/holds/${holdId}/resolution-requests`, {
        note: "x",
      });
      expect(DENIALS, role).toContain(x.json.error.code);
    }
  });

  it("rejects resolution signatures from every non-risk principal at the API and the contract", async () => {
    const c = a.w.c;
    const risk = a.actors["risk"] as Actor;
    const p = payload();
    const { fromTypedJson } = await import("@dockside/core");
    const canon = fromTypedJson(p);
    const sigs: Record<string, string> = {
      deterministicPolicy: await c.w.policySigner.sign("HOLD_SET", canon),
      manifestAttestor: await c.w.attestor.sign("MANIFEST_ATTESTATION", canon),
      executor: signFor(executorKey.privateKey, "HOLD_RESOLVE", canon),
    };
    for (const role of ["buyer", "supplier", "inspector", "auditor", "otherInspector"])
      sigs[role] = a.sign(a.actors[role] as Actor, "HOLD_RESOLVE", p);
    // The isolated service signers refuse the HOLD_RESOLVE purpose outright.
    await expect(c.w.policySigner.sign("HOLD_RESOLVE", canon)).rejects.toThrow();
    await expect(c.w.attestor.sign("HOLD_RESOLVE", canon)).rejects.toThrow();
    for (const [role, signature] of Object.entries(sigs)) {
      // (1) In the signer's own session (where one exists): denied before any signature check.
      const own = a.actors[role] as Actor | undefined;
      if (own) {
        const r = await a.http(own, "POST", `/v1/holds/${holdId}/resolution`, { payload: p, signature });
        expect(DENIALS, `${role} own session`).toContain(r.json.error.code);
      }
      // (2) Smuggled through the risk resolver's session: the signature is not the bound risk key.
      const r2 = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, { payload: p, signature });
      expect(r2.json.error.code, `${role} via risk session`).toBe("SIGNATURE_INVALID");
      // (3) Directly at the contract.
      const direct = c.exec(c.escrow.resolveHoldCall(c.t, p, signature), "anyone.testnet");
      expect(direct.ok, `${role} direct`).toBe(false);
    }
    expect(count(a, "hold_resolutions")).toBe(0);
  });

  it("a risk session cannot be reused by another key, and proofs cannot be replayed", async () => {
    const risk = a.actors["risk"] as Actor;
    const buyer = a.actors["buyer"] as Actor;
    const p = payload();
    const body = JSON.stringify({ payload: p, signature: a.sign(risk, "HOLD_RESOLVE", p) });
    const path = `/v1/holds/${holdId}/resolution`;
    const send = (proof: unknown) =>
      fetch(a.base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Dockside-Session ${risk.grant?.sessionToken}`,
          "dockside-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
        },
        body,
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
    // Buyer's key signing a proof for the risk session.
    const forged = await send(risk.proof("POST", path, body, buyer.key));
    expect(forged.status).toBe(401);
    expect(["UNAUTHENTICATED", "SIGNATURE_INVALID"]).toContain(forged.json.error.code);
    // Buyer's own session id with the risk token.
    const mixed = await send({ ...buyer.proof("POST", path, body) });
    expect(mixed.status).toBe(401);
    expect(count(a, "hold_resolutions")).toBe(0);
    // A valid proof is single use.
    const proof = risk.proof("POST", path, body);
    const ok = await send(proof);
    expect(ok.status).toBe(201);
    const replay = await send(proof);
    expect(["NONCE_REPLAYED", "UNAUTHENTICATED"]).toContain(replay.json.error.code);
    expect(count(a, "hold_resolutions")).toBe(1);
    // Accepted on the contract too, from any relayer.
    a.w.c.ok(a.w.c.escrow.resolveHoldCall(a.w.c.t, p, a.sign(risk, "HOLD_RESOLVE", p)), "anyone.testnet");
  });

  it("only exact fields verify: reason, manifest, expiry, hold and nonce are all bound", async () => {
    const c = a.w.c;
    const risk = a.actors["risk"] as Actor;
    holdId = await policyHold(a, 3600_000, "SECOND_REVIEW");
    const base = payload({});
    const struct = { ...(base as any).struct, holdReasonCode: { str: "SECOND_REVIEW" } };
    const mutate = (k: string, v: unknown) =>
      k === "expiresAt"
        ? { struct: { ...struct, issuedAt: { u64: String(Number(v && (v as any).u64) - 3600_000) }, [k]: v } }
        : { struct: { ...struct, [k]: v } };
    const now = c.w.h.clock.now();
    const cases: [string, unknown, string][] = [
      ["holdReasonCode", { str: "DOC_MISMATCH" }, "VALIDATION_FAILED"],
      ["manifestDigest", { str: "00".repeat(32) }, "STALE_MANIFEST"],
      ["expiresAt", { u64: String(now - 1) }, "EXPIRED"],
      ["resolverRole", { str: "POLICY_SETTER" }, "FORBIDDEN"],
    ];
    for (const [k, v, codeExpected] of cases) {
      const m = mutate(k, v);
      const r = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
        payload: m,
        signature: a.sign(risk, "HOLD_RESOLVE", m as never),
      });
      expect(r.json.error?.code, `${k}: ${r.text}`).toBe(codeExpected);
    }
    const good = { struct };
    const sig = a.sign(risk, "HOLD_RESOLVE", good as never);
    const ok = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
      payload: good,
      signature: sig,
    });
    expect(ok.status, ok.text).toBe(201);
    a.relay(ok);
    const again = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
      payload: good,
      signature: sig,
    });
    expect(again.json.error.code).toBe("INVALID_STATE");
  });

  it("a revoked risk key resolves nothing, through any session or the service", async () => {
    const c = a.w.c;
    const risk = a.actors["risk"] as Actor;
    const buyer = a.actors["buyer"] as Actor;
    holdId = await policyHold(a, 3600_000, "THIRD_REVIEW");
    const p = payload({});
    const good = { struct: { ...(p as any).struct, holdReasonCode: { str: "THIRD_REVIEW" } } };
    const sig = a.sign(risk, "HOLD_RESOLVE", good as never);
    const revoke = await a.http(
      a.actors["buyerAdmin"] as Actor,
      "POST",
      `/v1/keys/${risk.keyVersionId}/revoke`,
      {
        reason: "KEY_COMPROMISE",
      },
    );
    expect(revoke.status, revoke.text).toBe(201);
    const viaRisk = await a.http(risk, "POST", `/v1/holds/${holdId}/resolution`, {
      payload: good,
      signature: sig,
    });
    expect([401, 403]).toContain(viaRisk.status);
    expect(["UNAUTHENTICATED", "KEY_REVOKED"]).toContain(viaRisk.json.error.code);
    const viaBuyer = await a.http(buyer, "POST", `/v1/holds/${holdId}/resolution`, {
      payload: good,
      signature: sig,
    });
    expect(viaBuyer.json.error.code).toBe("FORBIDDEN");
    const { fromTypedJson } = await import("@dockside/core");
    expect(() => c.w.holds.recordResolve(c.t, fromTypedJson(good as never), sig)).toThrow(
      expect.objectContaining({ code: "KEY_REVOKED" }),
    );
    expect((await a.http(buyer, "GET", `/v1/trades/${c.t}/holds`)).json.holds.at(-1).status).toBe("ACTIVE");
  });
});
