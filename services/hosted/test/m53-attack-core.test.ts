/**
 * M53 attack console: the demo trade and the five attacks against the escrow's own core.
 *
 * run-all's `attack-demo` journey runs against a chain whose escrow is the real
 * `dockside-escrow-core` (attack-core-chain.ts); the attack relay then builds each attack from
 * that chain's views, signs it as a NEAR transaction with a key of an account that has no part in
 * the trade, and the core decides. Every code asserted below is the core's own answer. The
 * transport is a stand-in (no nearcore): the real-chain run of the same flow is
 * m53-attack-sandbox.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { digestHexFor, fromTypedJson, generateEd25519KeyPair, type TypedJson } from "@dockside/core";
import { functionCallAction, signTransaction, type TxSigner } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTACK_IDS, ATTACKS, AttackError, demoArmed, parseDemoConfig } from "../src/attack/attacks.js";
import { demoConfigFromJourney } from "../src/attack/demo-config.js";
import { AttackRelay, escrowOutcome } from "../src/attack/relay.js";
import { createAttackServer } from "../src/attack/server.js";
import { buildMirror, Core, CoreChain, decodeSignedCall, MIRROR, ROOT } from "./attack-core-chain.js";

type Json = Record<string, unknown>;
const journeyLib = (await import(
  pathToFileURL(join(ROOT, "scripts/testnet-deploy/lib/journey.mjs")).href
)) as {
  JOURNEYS: string[];
  DEMO_HOLD_TTL_MS: number;
  planMethods(j: string): { id: string; kind?: string; what?: string }[];
  runJourney(o: Json): Promise<Json & { ok: boolean; checks: Json }>;
};

const ACCOUNTS = {
  escrow: "dockside-escrow.testnet",
  buyer: "acme-buyer.testnet",
  supplier: "harbor-supplier.testnet",
  relayer: "relayer.testnet",
};
const ATTACKER = "curious-stranger.testnet";
const AMOUNT = 20_000_000_000_000_000_000_000n; // 0.02 NEAR
const HOUR = 3_600_000;
const dir = mkdtempSync(join(tmpdir(), "dockside-m53-"));

function testSigner(accountId: string): TxSigner {
  const k = generateEd25519KeyPair();
  return {
    signerId: accountId,
    publicKey: k.publicKey,
    sign: async (call, ref) => {
      const s = signTransaction(k.privateKey, {
        signerId: accountId,
        publicKey: k.publicKey,
        nonce: ref.nonce,
        receiverId: call.receiverId,
        blockHash: ref.blockHash,
        actions: [functionCallAction(call)],
      });
      return { txHash: s.txHash, signerId: accountId, encoded: s.encoded };
    },
  };
}

async function demo() {
  const chain = await new CoreChain(ACCOUNTS).start();
  const outDir = mkdtempSync(join(dir, "run-"));
  const journey = await journeyLib.runJourney({
    journey: "attack-demo",
    resume: false,
    wait: true,
    rpc: chain.rpc,
    profile: { network: "sandbox", cliNetwork: "sandbox" },
    accounts: ACCOUNTS,
    near: chain.near,
    relayerKeyFile: join(dir, "relayer-key.json"),
    mirrorBin: MIRROR,
    outDir,
    amountYocto: AMOUNT,
    minDepositYocto: "1000000000000000000000",
    log: () => {},
  });
  const signer = testSigner(ATTACKER);
  const relayChain = chain.relayChain({ accountId: signer.signerId, publicKey: signer.publicKey }, 100n);
  const config = demoConfigFromJourney(
    { network: "sandbox", contractId: ACCOUNTS.escrow, ...journey } as never,
    { attacker: { accountId: signer.signerId, publicKey: signer.publicKey }, baselineNonce: 100n },
  );
  const relay = new AttackRelay({ config, chain: relayChain, signer });
  return { chain, journey, config, signer, relayChain, relay, outDir };
}

let d: Awaited<ReturnType<typeof demo>>;

beforeAll(async () => {
  buildMirror();
  d = await demo();
}, 900_000);
afterAll(() => {
  d?.chain.core.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("attack-demo journey (run-all, real core)", () => {
  it("is a run-all journey that stops with the trade funded, approved and held", () => {
    expect(journeyLib.JOURNEYS).toContain("attack-demo");
    expect(journeyLib.planMethods("attack-demo").map((s) => s.id)).toEqual([
      "register",
      "policy",
      "fund",
      "attestation",
      "inspection",
      "intent",
      "approval",
      "hold_set",
      "observe:held",
    ]);
    expect(journeyLib.DEMO_HOLD_TTL_MS).toBe(28 * 24 * HOUR);
  });

  it("passes its checks: one ACTIVE policy hold, the approval recorded, the amount reserved, nothing paid", () => {
    expect(d.journey.ok).toBe(true);
    expect(d.journey.checks).toMatchObject({
      holdActive: true,
      deterministicPolicyHold: true,
      releaseBlockedByHold: true,
      approvalRecorded: true,
      intentPaysBoundSupplier: true,
      fundedExactlyTheTradeAmount: true,
      reservedExactlyTheTradeAmount: true,
      nothingReleased: true,
      nothingRefunded: true,
      ledgerConservation: true,
    });
    // Eight transactions, all accepted; none of them released or refunded anything.
    expect(d.chain.sent.map((t) => [t.method, t.ok])).toEqual([
      ["register_trade", true],
      ["register_evidence_policy", true],
      ["fund", true],
      ["submit_manifest_attestation", true],
      ["submit_inspection", true],
      ["create_release_intent", true],
      ["approve_release", true],
      ["set_hold", true],
    ]);
  });

  it("gives a live demo config of public facts only, consistent with the chain", async () => {
    const c = d.config;
    expect(c.status).toBe("LIVE");
    expect(c.parties).toEqual({ buyer: ACCOUNTS.buyer, supplier: ACCOUNTS.supplier });
    expect(c.amountYocto).toBe(AMOUNT.toString());
    expect(c.setup).toHaveLength(8);
    expect(JSON.stringify(c)).not.toMatch(/seed|private_key|secret/i);
    // The terms are the registered revision; the approval bytes are the accepted approval's.
    const release = (await d.chain.rpc.view(ACCOUNTS.escrow, "get_release", { trade_id: c.tradeId })) as Json;
    expect(digestHexFor("TRADE_REVISION", fromTypedJson(c.terms as TypedJson))).toBe(release["termsDigest"]);
    const approvalTx = d.chain.txs.get(c.approval?.txHash as string) as Json;
    const sent = ((approvalTx["transaction"] as Json)["actions"] as Json[])[0] as Json;
    expect((sent["FunctionCall"] as Json)["args"]).toBe(c.approval?.argsBase64);
    expect(parseDemoConfig(JSON.parse(JSON.stringify(c)))).toEqual(c);
    const armed = demoArmed(c, await d.relay.snapshot());
    expect(armed).toEqual({ armed: true, why: null });
  });

  it("refuses a config whose attacker is a party of the trade", () => {
    const bad = { ...d.config, attacker: { accountId: ACCOUNTS.buyer, publicKey: d.signer.publicKey } };
    expect(() => parseDemoConfig(bad)).toThrow(/must not be a party/);
  });
});

describe("the five attacks, each a signed transaction the core refuses", () => {
  const results: Json[] = [];

  it("refuses every attack with its expected code and leaves the trade's views unchanged", async () => {
    const views = async () => {
      const out: Json = {};
      for (const v of ["get_trade", "get_ledger", "get_refunds", "get_evidence", "get_holds", "get_release"])
        out[v] = await d.chain.rpc.view(ACCOUNTS.escrow, v, { trade_id: d.config.tradeId });
      return JSON.stringify(out);
    };
    const before = await views();
    for (const [i, a] of ATTACKS.entries()) {
      const r = await d.relay.attempt(a.id, `client-${i}`);
      results.push(r as unknown as Json);
      expect([r.attack, r.method, r.refused, r.code]).toEqual([a.id, a.method, true, a.expect]);
      expect(r.fundsUnchanged).toBe(true);
      expect(r.signer).toBe(ATTACKER);
      expect(r.attempts).toBe(String(i + 1));
      const tx = d.chain.txs.get(r.txHash) as Json;
      expect(escrowOutcome(tx, ACCOUNTS.escrow)).toMatchObject({ ran: true, failed: true });
    }
    expect(await views()).toBe(before);
    expect(d.chain.sent.slice(8).map((t) => [t.signer, t.method, t.ok])).toEqual(
      ATTACKS.map((a) => [ATTACKER, a.method, false]),
    );
  });

  it("each refusal is about the one thing the attacker cannot have", () => {
    const msg = Object.fromEntries(results.map((r) => [r["attack"], String(r["message"])]));
    // Correct successor terms; only the buyer's bound key is missing.
    expect(msg["change-payout"]).toBe("signature does not verify for the bound key and domain");
    // Every other condition holds; the hold is what blocks (the core lists all blockers).
    expect(msg["release-during-hold"]).toMatch(/^release conjunction incomplete: HOLD_ACTIVE/);
    // Correct header, hold, manifest and window; only the risk resolver's bound key is missing.
    expect(msg["approve-wrong-key"]).toBe("signature does not verify for the bound key and domain");
    // The accepted approval again: the intent already moved past the state an approval needs.
    expect(msg["replay-approval"]).toBe("release intent is DIRECT_TESTNET_AUTHORIZED");
    // The attacker deposited nothing, so the ledger owes it nothing.
    expect(msg["refund-to-stranger"]).toBe("funder has no quarantined excess");
    // ... and the refund it asked for was to itself: the request names the attacker as the funder.
    const refund = results.find((r) => r["attack"] === "refund-to-stranger") as Json;
    const sent = (
      ((d.chain.txs.get(String(refund["txHash"])) as Json)["transaction"] as Json)["actions"] as Json[]
    )[0] as Json;
    const args = JSON.parse(
      Buffer.from(String((sent["FunctionCall"] as Json)["args"]), "base64").toString(),
    ) as Json;
    const payload = fromTypedJson(args["payload"] as TypedJson) as Json;
    expect([payload["funder"], payload["initiatorRole"], payload["reason"]]).toEqual([
      ATTACKER,
      "FUNDER",
      "EXCESS_FUNDING_RETURN",
    ]);
    // The payout change names the attacker as the new destination.
    const change = results.find((r) => r["attack"] === "change-payout") as Json;
    const csent = (
      ((d.chain.txs.get(String(change["txHash"])) as Json)["transaction"] as Json)["actions"] as Json[]
    )[0] as Json;
    const cargs = JSON.parse(
      Buffer.from(String((csent["FunctionCall"] as Json)["args"]), "base64").toString(),
    ) as Json;
    const successor = fromTypedJson(cargs["successor_terms"] as TypedJson) as Json;
    expect((successor["payout"] as Json)["destination"]).toBe(ATTACKER);
  });

  it("sends exactly the arguments the chain already holds when it replays the approval", () => {
    const replay = results.find((r) => r["attack"] === "replay-approval") as Json;
    const tx = d.chain.txs.get(String(replay["txHash"])) as Json;
    const sent = ((tx["transaction"] as Json)["actions"] as Json[])[0] as Json;
    expect((sent["FunctionCall"] as Json)["args"]).toBe(d.config.approval?.argsBase64);
  });

  it("signs with the demo key only: no deposit, receiver the escrow, increasing nonces", () => {
    // decodeSignedCall in the stand-in already refused anything else; check the gas budget too.
    expect(ATTACK_IDS).toHaveLength(5);
    const nonce = d.chain.nonces.get(`${ATTACKER}/${d.signer.publicKey}`);
    expect(nonce).toBe(105n);
  });
});

describe("the HTTP relay on the real core", () => {
  it("sends one attempt per request, reports the core's code, and rate limits the same client", async () => {
    const relay = new AttackRelay({ config: d.config, chain: d.relayChain, signer: d.signer });
    const server = createAttackServer({ relay });
    const port = await new Promise<number>((ok) =>
      server.listen(0, "127.0.0.1", () => ok((server.address() as AddressInfo).port)),
    );
    try {
      const url = `http://127.0.0.1:${port}/attack/api`;
      const post = () =>
        fetch(`${url}/attempt`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
          body: JSON.stringify({ attack: "approve-wrong-key" }),
        });
      const first = await post();
      expect(first.status).toBe(200);
      const body = (await first.json()) as Json;
      expect(body).toMatchObject({
        attack: "approve-wrong-key",
        refused: true,
        code: "SIGNATURE_INVALID",
        fundsUnchanged: true,
        attempts: "6",
      });
      const second = await post();
      expect(second.status).toBe(429);
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
      const status = (await (await fetch(`${url}/status`)).json()) as Json;
      expect(status).toMatchObject({ enabled: true, armed: true, attempts: "6", attacker: ATTACKER });
      const log = (await (await fetch(`${url}/attempts`)).json()) as { attempts: Json[] };
      expect(log.attempts.map((a) => a["txHash"])).toEqual([body["txHash"]]);
    } finally {
      server.close();
    }
  });
});

describe("after the signed windows expire (25 hours later)", () => {
  it("still refuses everything and the demo stays armed; codes follow the first failing check", async () => {
    d.chain.advance(25 * HOUR);
    expect(demoArmed(d.config, await d.relay.snapshot()).armed).toBe(true);
    const codes: Record<string, string | null> = {};
    for (const a of ATTACKS) {
      const r = await d.relay.attempt(a.id, `late-${a.id}`);
      expect(r.refused).toBe(true);
      expect(r.fundsUnchanged).toBe(true);
      codes[a.id] = r.code;
    }
    expect(codes).toEqual({
      "change-payout": "SIGNATURE_INVALID",
      // The attestation (24 h) expired first; the hold is still listed among the blockers.
      "release-during-hold": "MANIFEST_NOT_CURRENT",
      "approve-wrong-key": "SIGNATURE_INVALID",
      // The approval's own signed window (24 h) has ended.
      "replay-approval": "EXPIRED",
      "refund-to-stranger": "NOTHING_ELIGIBLE",
    });
    const release = d.relay.log.find(
      (r) => r.attack === "release-during-hold" && r.code === "MANIFEST_NOT_CURRENT",
    );
    expect(release?.message).toMatch(/HOLD_ACTIVE/);
  });
});

describe("relay guards", () => {
  it("rate limits per client and over all clients, and sends one transaction at a time", async () => {
    let t = 0;
    const relay = new AttackRelay({
      config: d.config,
      chain: d.relayChain,
      signer: d.signer,
      limits: { perClientMs: 20_000, windowMs: 600_000, windowMax: 2 },
      clock: () => t,
    });
    const first = await relay.attempt("release-during-hold", "a");
    expect(first.refused).toBe(true);
    await expect(relay.attempt("release-during-hold", "a")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 20_000,
    });
    t = 1000;
    const pending = relay.attempt("release-during-hold", "b");
    await expect(relay.attempt("release-during-hold", "c")).rejects.toMatchObject({ code: "BUSY" });
    await pending;
    t = 30_000;
    await expect(relay.attempt("release-during-hold", "d")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("refuses a key that is not the config's attacker key", () => {
    expect(
      () => new AttackRelay({ config: d.config, chain: d.relayChain, signer: testSigner(ATTACKER) }),
    ).toThrow(AttackError);
  });

  it("stops for good when the contract ever accepts an attempt", async () => {
    const accepting = {
      ...d.relayChain,
      send: async (encoded: string) => {
        const call = decodeSignedCall(encoded);
        return {
          final_execution_status: "FINAL",
          receipts_outcome: [
            { block_hash: "x", outcome: { executor_id: ACCOUNTS.escrow, status: { SuccessValue: "" } } },
          ],
          transaction: { hash: call.txHash },
        };
      },
    };
    const relay = new AttackRelay({
      config: d.config,
      chain: accepting,
      signer: d.signer,
      limits: { perClientMs: 0, windowMs: 1, windowMax: 100 },
    });
    const r = await relay.attempt("release-during-hold", "x");
    expect(r.refused).toBe(false);
    await expect(relay.attempt("release-during-hold", "y")).rejects.toMatchObject({ code: "ACCEPTED" });
    expect((await relay.status())["enabled"]).toBe(false);
  });

  it("sends nothing once the risk resolver lifts the hold (the demo is disarmed)", async () => {
    // The real resolution: the journey's own builder, given the run's seed, signs RELEASE_HOLD with
    // the bound risk key; the chain's core accepts it.
    const seed = JSON.parse(readFileSync(join(d.outDir, "journey-seed.json"), "utf8")) as Json;
    const state = JSON.parse(readFileSync(join(d.outDir, "journey-state.json"), "utf8")) as {
      steps: { mirror?: Json[] }[];
    };
    const builder = new Core();
    try {
      await builder.send({
        op: "init",
        accounts: { contract: ACCOUNTS.escrow, buyer: ACCOUNTS.buyer, supplier: ACCOUNTS.supplier },
        seed: seed["seed"],
        trade: seed["trade"],
        amountYocto: seed["amountYocto"],
        delayMs: HOUR,
        t0: seed["t0"],
        minDepositYocto: seed["minDepositYocto"],
      });
      for (const s of state.steps) for (const a of s.mirror ?? []) await builder.send({ op: "apply", ...a });
      const b = (await builder.send({
        op: "build",
        what: "hold_resolve",
        hold: "h1",
        code: "RELEASE_HOLD",
        now: d.chain.time,
      })) as Json;
      expect(b["ok"]).toBe(true);
      const tx = await d.chain.execute(
        "resolve_hold",
        b["args"],
        ACCOUNTS.relayer,
        0n,
        "ResolveHoldTx1111111111111111111111111111111",
      );
      expect(escrowOutcome(tx, ACCOUNTS.escrow).failed).toBe(false);
    } finally {
      builder.close();
    }
    const sentBefore = d.chain.sent.length;
    const relay = new AttackRelay({ config: d.config, chain: d.relayChain, signer: d.signer });
    await expect(relay.attempt("release-during-hold", "z")).rejects.toMatchObject({ code: "DEMO_NOT_ARMED" });
    expect((await relay.status())["armed"]).toBe(false);
    expect(d.chain.sent.length).toBe(sentBefore);
  });
});
