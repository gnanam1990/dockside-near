/**
 * M53 attack console against a REAL nearcore node (the local NEAR sandbox in a Linux container,
 * scripts/near-sandbox), never testnet. Opt-in: DOCKSIDE_NEAR_SANDBOX=1, Docker (inside WSL on
 * Windows) and the deployable wasm in .data/repro.
 *
 * Real transactions throughout, signed by Dockside's own NEAR encoder: the accounts, the escrow
 * deployment, the relayer's and the demo attacker's function-call keys restricted to the escrow,
 * then run-all's `attack-demo` journey (its driver and payload builder, with near-cli-rs replaced
 * by the same encoder), then the five attacks through the production relay code: the
 * `KeyFileTxSigner` loads the demo key file, the relay builds each attack from the node's views,
 * and nearcore runs the contract. The HTTP relay and the hosted front are exercised on loopback.
 *
 * With DOCKSIDE_M53_RECORD=1 the node's answers to the requests the page makes are written to
 * fixtures/attack/ for the browser suite (apps/web/e2e-proof/attack.spec.ts).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonRpcNearClient, KeyFileTxSigner, signTransaction } from "@dockside/near";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  keyFromFile,
  NEAR,
  type ProductChain,
  prepareProductChain,
  type Sandbox,
  sendTx,
  startSandbox,
  newKey,
  writeKeyFile,
} from "../../../scripts/near-sandbox/product-chain.mjs";
import { ATTACKS, type DemoConfig } from "../src/attack/attacks.js";
import { demoConfigFromJourney } from "../src/attack/demo-config.js";
import { AttackRelay, type AttemptResult, rpcChain } from "../src/attack/relay.js";
import { createAttackServer } from "../src/attack/server.js";
import { createFront } from "../src/front.js";
import { buildMirror, MIRROR, ROOT } from "./attack-core-chain.js";

type Json = Record<string, unknown>;
const ENABLED = process.env["DOCKSIDE_NEAR_SANDBOX"] === "1";
const PORT = Number(process.env["DOCKSIDE_M53_SANDBOX_PORT"] ?? 9101);
const REPRO = fileURLToPath(new URL("../../../.data/repro/", import.meta.url));
const AMOUNT = 20_000_000_000_000_000_000_000n;
const TGAS = 10n ** 12n;

const lib = (p: string) => import(pathToFileURL(join(ROOT, p)).href);
const journeyLib = (await lib("scripts/testnet-deploy/lib/journey.mjs")) as {
  runJourney(o: Json): Promise<Json & { ok: boolean; checks: Json }>;
};
const tools = (await lib("scripts/testnet-deploy/lib/near-tools.mjs")) as {
  Rpc: new (
    urls: string[],
  ) => {
    request(method: string, params: Json): Promise<unknown>;
    view(contract: string, method: string, args: Json): Promise<unknown>;
  };
};

/** near-cli-rs `contract call-function as-transaction ... send`, signed with Dockside's encoder. */
function nearCli(rpcUrl: string, buyerKeyFile: string) {
  const rpc = new JsonRpcNearClient({
    endpoint: rpcUrl,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 60_000,
    maxResponseBytes: 4 << 20,
  });
  return async (argv: string[]) => {
    const escrow = argv[3] as string;
    const method = argv[4] as string;
    const file = argv[6] as string;
    const deposit = BigInt(String(argv[10]).split(" ")[0] ?? "0");
    const signerId = argv[12] as string;
    const keyFile = argv[15] === "sign-with-access-key-file" ? (argv[16] as string) : buyerKeyFile;
    const k = keyFromFile(keyFile);
    if (k.accountId !== signerId) throw new Error(`key file is for ${k.accountId}, not ${signerId}`);
    const nonce = (await rpc.viewAccessKey(signerId, k.publicKey)).nonce + 1n;
    const block = (await rpc.request("block", { finality: "final" })) as { header: { hash: string } };
    const signed = signTransaction(k.privateKey, {
      signerId,
      publicKey: k.publicKey,
      nonce,
      receiverId: escrow,
      blockHash: block.header.hash,
      actions: [
        {
          kind: "FunctionCall",
          methodName: method,
          args: new Uint8Array(readFileSync(file)),
          gas: 100n * TGAS,
          depositYocto: deposit,
        },
      ],
    });
    const r = (await rpc.request("send_tx", {
      signed_tx_base64: signed.encoded,
      wait_until: "FINAL",
    })) as Json;
    const failed =
      typeof r["status"] === "object" && r["status"] !== null && "Failure" in (r["status"] as Json);
    const text = `${failed ? "ERROR Transaction failed" : "Transaction Execution Info:"}\n  Transaction ID: ${signed.txHash}\n`;
    return { status: failed ? 1 : 0, text, clean: text, txHash: signed.txHash };
  };
}

describe.skipIf(!ENABLED)("M53 attack console on a local nearcore sandbox", () => {
  let sb: Sandbox;
  let chain: ProductChain;
  let dir = "";
  let attacker = { accountId: "", keyFile: "", publicKey: "" };
  let journey: Json & { ok: boolean; checks: Json };
  let config: DemoConfig;
  let relay: AttackRelay;
  const results: AttemptResult[] = [];
  const views = async () => {
    const rpc = new tools.Rpc([sb.rpcUrl]);
    const out: Json = {};
    for (const v of ["get_trade", "get_ledger", "get_refunds", "get_evidence", "get_holds", "get_release"])
      out[v] = await rpc.view(config.escrow as string, v, { trade_id: config.tradeId });
    // get_release and get_holds report statuses at the view's block time; strip nothing: the demo's
    // windows are hours long, so two reads seconds apart agree.
    return JSON.stringify(out);
  };

  beforeAll(async () => {
    buildMirror();
    dir = mkdtempSync(join(tmpdir(), "dockside-m53-sandbox-"));
    sb = await startSandbox({ name: "dockside-m53-attack-sandbox", port: PORT });
    chain = await prepareProductChain(sb, { wasm: join(REPRO, "dockside_escrow.wasm"), dir });
    // The demo attacker: its own account (a stranger to the trade) with a function-call key
    // restricted to the escrow, like the one the owner adds on testnet.
    const accountId = `stranger.${sb.root.accountId}`;
    const full = newKey();
    await sendTx(sb.rpcUrl, sb.root, accountId, [
      { kind: "CreateAccount" },
      { kind: "Transfer", depositYocto: 2n * NEAR },
      { kind: "AddKey", publicKey: full.publicKey, permission: { kind: "FullAccess" } },
    ]);
    const fc = newKey();
    await sendTx(sb.rpcUrl, { accountId, ...full }, accountId, [
      {
        kind: "AddKey",
        publicKey: fc.publicKey,
        permission: {
          kind: "FunctionCall",
          allowanceYocto: NEAR / 2n,
          receiverId: chain.accounts.escrow,
          methodNames: [],
        },
      },
    ]);
    attacker = {
      accountId,
      publicKey: fc.publicKey,
      keyFile: writeKeyFile(join(dir, "attacker-function-call-key.json"), accountId, fc),
    };

    const outDir = mkdtempSync(join(dir, "run-"));
    const rpc = new tools.Rpc([sb.rpcUrl]);
    const minDeposit = ((await rpc.view(chain.accounts.escrow, "get_config", {})) as Json)["minDepositYocto"];
    journey = await journeyLib.runJourney({
      journey: "attack-demo",
      resume: false,
      wait: true,
      rpc,
      profile: { network: "sandbox", cliNetwork: "sandbox" },
      accounts: {
        escrow: chain.accounts.escrow,
        buyer: chain.accounts.buyer,
        supplier: chain.accounts.supplier,
        relayer: chain.accounts.relayer,
      },
      near: nearCli(sb.rpcUrl, chain.buyerKeyFile),
      relayerKeyFile: chain.relayerKeyFile,
      mirrorBin: MIRROR,
      outDir,
      amountYocto: AMOUNT,
      minDepositYocto: minDeposit,
      log: (m: string) => process.stdout.write(`journey: ${m}\n`),
    });
    const signer = KeyFileTxSigner.load({
      accountId,
      receiverId: chain.accounts.escrow,
      keyFile: attacker.keyFile,
    });
    const onChain = await signer.verifyOnChain(
      new JsonRpcNearClient({
        endpoint: sb.rpcUrl,
        allowedHosts: ["127.0.0.1"],
        timeoutMs: 30_000,
        maxResponseBytes: 1 << 20,
      }),
    );
    config = demoConfigFromJourney(
      { network: "sandbox", contractId: chain.accounts.escrow, ...journey } as never,
      {
        attacker: { accountId, publicKey: signer.publicKey },
        baselineNonce: onChain.nonce,
        rpc: [sb.rpcUrl],
        explorer: "http://127.0.0.1/sandbox-has-no-explorer/",
      },
    );
    relay = new AttackRelay({
      config,
      chain: rpcChain(sb.rpcUrl),
      signer,
      limits: { perClientMs: 0, windowMs: 60_000, windowMax: 50 },
    });
  }, 1_200_000);

  afterAll(() => {
    if (process.env["DOCKSIDE_NEAR_SANDBOX_LOGS"] === "1" && sb) process.stdout.write(sb.logs());
    sb?.stop();
  });

  it("run-all's attack-demo journey leaves the trade funded, approved and held on the node", () => {
    expect(journey.ok).toBe(true);
    expect(journey.checks).toMatchObject({
      holdActive: true,
      releaseBlockedByHold: true,
      approvalRecorded: true,
      intentPaysBoundSupplier: true,
      reservedExactlyTheTradeAmount: true,
      nothingReleased: true,
      nothingRefunded: true,
      ledgerConservation: true,
    });
    expect(config.setup.map((s) => s.method)).toEqual([
      "register_trade",
      "register_evidence_policy",
      "fund",
      "submit_manifest_attestation",
      "submit_inspection",
      "create_release_intent",
      "approve_release",
      "set_hold",
    ]);
  });

  it("the stored approval bytes are the approval transaction's arguments on the node", async () => {
    const step = config.setup.find((s) => s.step === "approval");
    const tx = await rpcChain(sb.rpcUrl).txStatus(config.approval?.txHash as string, step?.signer as string);
    const call = ((tx["transaction"] as Json)["actions"] as Json[])[0] as Json;
    expect((call["FunctionCall"] as Json)["args"]).toBe(config.approval?.argsBase64);
  });

  it("nearcore refuses all five attacks with the expected codes; nothing about the trade changes", async () => {
    const before = await views();
    const balance = async (id: string) =>
      BigInt(
        (
          (await new tools.Rpc([sb.rpcUrl]).request("query", {
            request_type: "view_account",
            finality: "final",
            account_id: id,
          })) as Json
        )["amount"] as string,
      );
    const supplierBefore = await balance(chain.accounts.supplier);
    const attackerBefore = await balance(attacker.accountId);
    for (const [i, a] of ATTACKS.entries()) {
      const r = await relay.attempt(a.id, "sandbox");
      results.push(r);
      process.stdout.write(`attack ${a.id}: ${r.txHash} ${r.code} ${r.message}\n`);
      expect([r.attack, r.method, r.refused, r.code, r.fundsUnchanged]).toEqual([
        a.id,
        a.method,
        true,
        a.expect,
        true,
      ]);
      expect(r.attempts).toBe(String(i + 1));
    }
    expect(await views()).toBe(before);
    expect(await balance(chain.accounts.supplier)).toBe(supplierBefore);
    // The attacker only paid gas, and received nothing.
    const spent = attackerBefore - (await balance(attacker.accountId));
    expect(spent > 0n && spent < NEAR / 100n).toBe(true);
    // Read back independently: every attempt is a failed transaction from the attacker to the escrow.
    for (const r of results) {
      const tx = (await new tools.Rpc([sb.rpcUrl]).request("EXPERIMENTAL_tx_status", {
        tx_hash: r.txHash,
        sender_account_id: attacker.accountId,
        wait_until: "FINAL",
      })) as Json;
      const t = tx["transaction"] as Json;
      expect([t["signer_id"], t["receiver_id"]]).toEqual([attacker.accountId, chain.accounts.escrow]);
      expect(JSON.stringify(tx["status"])).toContain(`DOCKSIDE:${r.code}: `);
    }
  });

  it("the HTTP relay behind the hosted front sends a real attempt and rate limits the next", async () => {
    const httpRelay = new AttackRelay({
      config,
      chain: rpcChain(sb.rpcUrl),
      signer: KeyFileTxSigner.load({
        accountId: attacker.accountId,
        receiverId: config.escrow as string,
        keyFile: attacker.keyFile,
      }),
    });
    const api = createAttackServer({ relay: httpRelay });
    await new Promise<void>((ok) => api.listen(9102, "127.0.0.1", ok));
    const web = mkdtempSync(join(dir, "web-"));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>app</title>");
    const front = createFront({
      webRoot: web,
      origin: "http://127.0.0.1:9103",
      apiPort: 9,
      relayPort: 9,
      proof: { root: join(ROOT, "site/proof"), attackPort: 9102 },
    });
    await new Promise<void>((ok) => front.listen(9103, "127.0.0.1", ok));
    try {
      const base = `http://127.0.0.1:${(front.address() as AddressInfo).port}/proof/attack/api`;
      const status = (await (await fetch(`${base}/status`)).json()) as Json;
      expect(status).toMatchObject({ enabled: true, armed: true, attempts: "5" });
      const post = () =>
        fetch(`${base}/attempt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attack: "release-during-hold" }),
        });
      const first = await post();
      expect(first.status).toBe(200);
      const body = (await first.json()) as AttemptResult;
      expect([body.refused, body.code, body.attempts]).toEqual([true, "HOLD_ACTIVE", "6"]);
      results.push(body);
      const second = await post();
      expect(second.status).toBe(429);
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      api.close();
      front.close();
    }
  });

  it("records the node's answers to the page's requests (DOCKSIDE_M53_RECORD=1)", async () => {
    if (process.env["DOCKSIDE_M53_RECORD"] !== "1") return;
    const { requestKey } = (await lib("scripts/proof/replay-rpc.mjs")) as { requestKey(r: Json): string };
    const answers: Record<string, unknown> = {};
    const raw = async (method: string, params: Json) => {
      const res = await fetch(sb.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const b = (await res.json()) as Json;
      answers[requestKey({ method, params })] = b["result"];
    };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
    for (const m of ["get_ledger", "get_release", "get_holds"])
      await raw("query", {
        request_type: "call_function",
        account_id: config.escrow,
        method_name: m,
        args_base64: b64({ trade_id: config.tradeId }),
        finality: "final",
      });
    await raw("query", {
      request_type: "view_access_key",
      account_id: attacker.accountId,
      public_key: attacker.publicKey,
      finality: "final",
    });
    for (const r of results)
      await raw("EXPERIMENTAL_tx_status", {
        tx_hash: r.txHash,
        sender_account_id: attacker.accountId,
        wait_until: "FINAL",
      });
    const out = join(ROOT, "fixtures/attack");
    mkdirSync(out, { recursive: true });
    const recorded = results.map((r) => ({
      attack: r.attack,
      txHash: r.txHash,
      signer: r.signer,
      code: r.code,
      blockTimeMs: null,
    }));
    writeFileSync(
      join(out, "sandbox-recording.json"),
      `${JSON.stringify({ schema: "dockside/rpc-recording@1", source: "local near-sandbox node (nearcore), M53 sandbox suite", recordedAt: new Date().toISOString(), answers }, null, 2)}\n`,
    );
    writeFileSync(
      join(out, "sandbox-demo.json"),
      `${JSON.stringify({ ...config, rpc: ["https://test.rpc.fastnear.com"], recorded }, null, 2)}\n`,
    );
    writeFileSync(join(out, "sandbox-relay-answers.json"), `${JSON.stringify(results, null, 2)}\n`);
  });
});
