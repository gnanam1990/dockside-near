/**
 * M43 production relayer signer against a REAL nearcore node: the local NEAR sandbox in a Linux
 * container (scripts/near-sandbox), not testnet. Opt-in: runs only with DOCKSIDE_NEAR_SANDBOX=1
 * (`pnpm run build && pnpm run test:sandbox`), because it needs Docker (inside WSL on Windows) and the
 * deployable wasm in .data/repro (`pnpm run contract:reproduce`).
 *
 * Every account, the escrow deployment (`new` in the same transaction) and the relayer's
 * function-call key restricted to the escrow are made by real transactions signed by Dockside's own
 * encoder. Then the production `KeyFileTxSigner` loads the near-cli-rs key file, nearcore accepts
 * what it signs, nonces come from `view_access_key` through the journal's relayer-key lease (two
 * submitters in parallel never collide), an identical re-broadcast is the same transaction, and the
 * chain preflight accepts exactly the manifest's code hash.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomIds, systemClock } from "@dockside/core";
import { Journal } from "@dockside/journal";
import {
  EscrowContract,
  JsonRpcNearClient,
  KeyFileTxSigner,
  NearTxClient,
  preflightEscrow,
} from "@dockside/near";
import { Database } from "@dockside/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ProductChain,
  prepareProductChain,
  type Sandbox,
  startSandbox,
} from "../../../scripts/near-sandbox/product-chain.mjs";
import { RelayerSubmitter } from "../src/submit.js";

const ENABLED = process.env["DOCKSIDE_NEAR_SANDBOX"] === "1";
const PORT = Number(process.env["DOCKSIDE_M43_SANDBOX_PORT"] ?? 4541);
const REPRO = fileURLToPath(new URL("../../../.data/repro/", import.meta.url));
const WASM = join(REPRO, "dockside_escrow.wasm");
const MANIFEST = join(REPRO, "build-manifest.json");

const rpc = (url: string, timeoutMs = 60_000) =>
  new JsonRpcNearClient({ endpoint: url, allowedHosts: ["127.0.0.1"], timeoutMs, maxResponseBytes: 4 << 20 });

describe.skipIf(!ENABLED)("M43 relayer function-call key signer on a local nearcore sandbox", () => {
  let sb: Sandbox;
  let chain: ProductChain;
  let dir = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dockside-m43-sandbox-"));
    sb = await startSandbox({ name: "dockside-m43-relayer-sandbox", port: PORT });
    chain = await prepareProductChain(sb, { wasm: WASM, dir });
  }, 600_000);

  afterAll(() => {
    if (process.env["DOCKSIDE_NEAR_SANDBOX_LOGS"] === "1" && sb) process.stdout.write(sb.logs());
    sb?.stop();
  });

  const load = () =>
    KeyFileTxSigner.load({
      accountId: chain.accounts.relayer,
      receiverId: chain.accounts.escrow,
      keyFile: chain.relayerKeyFile,
    });

  it("the chain preflight accepts the deployed escrow and refuses another code hash", async () => {
    const ok = await preflightEscrow({
      rpc: rpc(sb.rpcUrl),
      rpcUrl: sb.rpcUrl,
      escrowId: chain.accounts.escrow,
      manifestPath: MANIFEST,
      expectedChainId: sb.chainId,
    });
    // The code hash of the wasm this run deployed: the build manifest's, whatever build that is
    // (it was pinned to the escrow2 build's literal until the contract changed in M50).
    const built = JSON.parse(readFileSync(MANIFEST, "utf8")).contract.nearCodeHash as string;
    expect(built).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(ok.codeHash).toBe(built);
    expect(ok.contractNetwork).toBe("near-testnet");
    const other = join(dir, "other-manifest.json");
    writeFileSync(other, JSON.stringify({ nearCodeHash: "11111111111111111111111111111111" }));
    await expect(
      preflightEscrow({
        rpc: rpc(sb.rpcUrl),
        rpcUrl: sb.rpcUrl,
        escrowId: chain.accounts.escrow,
        manifestPath: other,
        expectedChainId: sb.chainId,
      }),
    ).rejects.toMatchObject({ details: { reason: "CODE_HASH_MISMATCH" } });
    // An account without the contract (the buyer) is refused too.
    await expect(
      preflightEscrow({
        rpc: rpc(sb.rpcUrl),
        rpcUrl: sb.rpcUrl,
        escrowId: chain.accounts.buyer,
        manifestPath: MANIFEST,
        expectedChainId: sb.chainId,
      }),
    ).rejects.toMatchObject({ details: { reason: "CODE_HASH_MISMATCH" } });
  });

  it("nearcore confirms the key is a function-call key restricted to the escrow; a full-access key is refused", async () => {
    const s = load();
    const on = await s.verifyOnChain(rpc(sb.rpcUrl));
    expect(on.nonce).toBeGreaterThan(0n);
    const full = KeyFileTxSigner.load({
      accountId: chain.accounts.relayer,
      receiverId: chain.accounts.escrow,
      keyFile: chain.relayerFullKeyFile,
    });
    await expect(full.verifyOnChain(rpc(sb.rpcUrl))).rejects.toMatchObject({
      details: { reason: "FULL_ACCESS_KEY" },
    });
  });

  it("nearcore executes what the signer signs; a re-broadcast is the same transaction; a stale nonce is refused", async () => {
    const s = load();
    const tx = new NearTxClient(rpc(sb.rpcUrl));
    const escrow = new EscrowContract(rpc(sb.rpcUrl), chain.accounts.escrow);
    // A real escrow call the relayer may send: the contract refuses an unknown trade, which still
    // proves nearcore accepted the signature, the nonce and the function-call key's restriction.
    const call = escrow.executeReleaseCall(
      "trd_00000000000000000000000000000001",
      "rli_00000000000000000000000000000001",
    );
    const nonce = (await tx.accessKeyNonce(s.signerId, s.publicKey)) + 1n;
    const block = await tx.latestBlock();
    const signed = await s.sign(call, { nonce, blockHash: block.hash });
    const out = await tx.send(signed);
    expect(out.kind).toBe("FINAL_FAILURE");
    expect(out.kind !== "NOT_FOUND" && out.error).toMatch(/DOCKSIDE:/);
    // The access key's nonce is now exactly the one the signer used.
    expect(await tx.accessKeyNonce(s.signerId, s.publicKey)).toBe(nonce);
    // Re-broadcasting the persisted bytes is the identical transaction (same hash, executed once).
    const again = await tx.send(signed);
    expect(again.txHash).toBe(signed.txHash);
    const st = await tx.status(signed.txHash, s.signerId);
    expect(st.kind).toBe("FINAL_FAILURE");
    expect(await tx.accessKeyNonce(s.signerId, s.publicKey)).toBe(nonce);
    // A different transaction with an already used nonce is refused by nearcore before inclusion.
    const stale = await s.sign({ ...call, gas: "40000000000000" }, { nonce, blockHash: block.hash });
    await expect(tx.send(stale)).rejects.toBeTruthy();
  });

  it("two submitters sharing the relayer key through the journal lease get distinct nonces and both land", async () => {
    const db = Database.open(join(dir, "journal.sqlite"));
    db.migrate();
    const journal = new Journal(db, systemClock, randomIds);
    const tx = new NearTxClient(rpc(sb.rpcUrl));
    const escrow = new EscrowContract(rpc(sb.rpcUrl), chain.accounts.escrow);
    const a = new RelayerSubmitter(journal, load(), tx, { holder: "a", leaseTtlMs: 60_000, waitMs: 120_000 });
    const b = new RelayerSubmitter(journal, load(), tx, { holder: "b", leaseTtlMs: 60_000, waitMs: 120_000 });
    const before = await tx.accessKeyNonce(chain.accounts.relayer, chain.relayerFcPublicKey);
    const call = (n: number) =>
      escrow.executeReleaseCall(
        `trd_0000000000000000000000000000000${n}`,
        "rli_00000000000000000000000000000001",
      );
    const [ra, rb] = await Promise.all([a.submit(call(2)), b.submit(call(3))]);
    for (const r of [ra, rb]) {
      expect(r.outcome).toBe("FINAL_FAILURE");
      expect(r.error).toMatch(/DOCKSIDE:/);
    }
    expect(ra.txHash).not.toBe(rb.txHash);
    expect(await tx.accessKeyNonce(chain.accounts.relayer, chain.relayerFcPublicKey)).toBe(before + 2n);
    db.close();
  });

  it("the signer refuses a deposit and another receiver before anything reaches the node", async () => {
    const s = load();
    const ref = { nonce: 1n, blockHash: (await new NearTxClient(rpc(sb.rpcUrl)).latestBlock()).hash };
    const escrow = new EscrowContract(rpc(sb.rpcUrl), chain.accounts.escrow);
    await expect(
      s.sign(escrow.fundCall("trd_00000000000000000000000000000001", "a".repeat(64), 1n), ref),
    ).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    await expect(
      s.sign({ ...escrow.executeReleaseCall("trd_1", "rli_1"), receiverId: chain.accounts.buyer }, ref),
    ).rejects.toMatchObject({ code: "WRONG_CONTRACT" });
  });
});
