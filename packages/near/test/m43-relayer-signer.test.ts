/**
 * M43 relayer TxSigner with real key custody: NEAR borsh transaction encoding, Ed25519 signing,
 * near-cli-rs key-file loading with permission checks, the on-chain key restriction check and the
 * chain preflight. The real-node proof (nearcore accepts these transactions) is in
 * m43-relayer-signer-sandbox.test.ts (`pnpm run test:sandbox`).
 */
import { createHash, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { base58Decode, base58Encode } from "@dockside/core";
import {
  checkKeyFilePermissions,
  encodeTransaction,
  KeyFileTxSigner,
  manifestCodeHash,
  preflightEscrow,
  signTransaction,
} from "@dockside/near";
import { describe, expect, it } from "vitest";

const ESCROW = "dockside-escrow.testnet";
const RELAYER = "dockside-relayer.testnet";

interface TestKey {
  publicKey: string;
  /** base58 of seed ++ public key, as near-cli-rs writes it. */
  secret64: string;
  secret32: string;
  privateKey: KeyObject;
}

function newKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(String(jwk.d), "base64url");
  const pub = Buffer.from(String(jwk.x), "base64url");
  void publicKey;
  return {
    publicKey: `ed25519:${base58Encode(pub)}`,
    secret64: `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`,
    secret32: `ed25519:${base58Encode(seed)}`,
    privateKey,
  };
}

const dir = mkdtempSync(join(tmpdir(), "dockside-m43-signer-"));
let n = 0;
/** Writes a key file the way near-cli-rs does (owner-only where the platform has mode bits). */
function keyFile(doc: Record<string, unknown>): string {
  const f = join(dir, `k${++n}.json`);
  writeFileSync(f, JSON.stringify(doc), { mode: 0o600 });
  return f;
}
const okAcl = () =>
  "C:\\x\\k.json NT AUTHORITY\\SYSTEM:(I)(F)\n  BUILTIN\\Administrators:(I)(F)\n  HOST\\owner:(I)(F)\n";

/* ------------------------------ minimal borsh reader ------------------------------ */

class Reader {
  off = 0;
  constructor(readonly b: Buffer) {}
  u8() {
    return this.b.readUInt8(this.off++);
  }
  u32() {
    const v = this.b.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    const v = this.b.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  u128() {
    const lo = this.b.readBigUInt64LE(this.off);
    const hi = this.b.readBigUInt64LE(this.off + 8);
    this.off += 16;
    return (hi << 64n) | lo;
  }
  fixed(len: number) {
    const v = this.b.subarray(this.off, this.off + len);
    this.off += len;
    return v;
  }
  bytes() {
    return this.fixed(this.u32());
  }
  str() {
    return this.bytes().toString("utf8");
  }
}

function decodeSignedFunctionCall(encoded: string) {
  const r = new Reader(Buffer.from(encoded, "base64"));
  const signerId = r.str();
  expect(r.u8()).toBe(0);
  const publicKey = `ed25519:${base58Encode(r.fixed(32))}`;
  const nonce = r.u64();
  const receiverId = r.str();
  const blockHash = base58Encode(r.fixed(32));
  expect(r.u32()).toBe(1);
  expect(r.u8()).toBe(2);
  const methodName = r.str();
  const args = JSON.parse(r.bytes().toString("utf8"));
  const gas = r.u64();
  const deposit = r.u128();
  const bodyEnd = r.off;
  expect(r.u8()).toBe(0);
  const signature = r.fixed(64);
  expect(r.off).toBe(r.b.length);
  return {
    signerId,
    publicKey,
    nonce,
    receiverId,
    blockHash,
    methodName,
    args,
    gas,
    deposit,
    body: r.b.subarray(0, bodyEnd),
    signature,
  };
}

const BLOCK = base58Encode(createHash("sha256").update("block").digest());
const CALL = {
  receiverId: ESCROW,
  methodName: "execute_release",
  args: { trade_id: "trd_00000000000000000000000000000001", release_intent_id: "rli_1" },
  gas: "150000000000000",
  depositYocto: "0",
};

describe("M43 NEAR borsh transactions", () => {
  it("encodes a transfer byte-for-byte like nearcore (near-api-js serialization vector)", () => {
    const bytes = encodeTransaction({
      signerId: "test.near",
      publicKey: "ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC",
      nonce: 1n,
      receiverId: "whatever.near",
      blockHash: "244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM",
      actions: [{ kind: "Transfer", depositYocto: 1n }],
    });
    expect(Buffer.from(bytes).toString("hex")).toBe(
      "09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6010000000301000000000000000000000000000000",
    );
  });

  it("signs the sha256 of the transaction; the hash is the transaction id; signing is deterministic", () => {
    const k = newKey();
    const tx = {
      signerId: RELAYER,
      publicKey: k.publicKey,
      nonce: 42n,
      receiverId: ESCROW,
      blockHash: BLOCK,
      actions: [
        {
          kind: "FunctionCall" as const,
          methodName: "m",
          args: new Uint8Array([123, 125]),
          gas: 1n,
          depositYocto: 0n,
        },
      ],
    };
    const a = signTransaction(k.privateKey, tx);
    const b = signTransaction(k.privateKey, tx);
    expect(b).toEqual(a);
    const body = encodeTransaction(tx);
    const digest = createHash("sha256").update(body).digest();
    expect(a.txHash).toBe(base58Encode(digest));
    const raw = Buffer.from(a.encoded, "base64");
    expect(raw.subarray(0, body.length).equals(Buffer.from(body))).toBe(true);
    expect(raw[body.length]).toBe(0);
    expect(
      verify(
        null,
        digest,
        {
          key: {
            kty: "OKP",
            crv: "Ed25519",
            x: Buffer.from(base58Decode(k.publicKey.slice(8))).toString("base64url"),
          },
          format: "jwk",
        },
        raw.subarray(body.length + 1),
      ),
    ).toBe(true);
    expect(signTransaction(k.privateKey, { ...tx, nonce: 43n }).txHash).not.toBe(a.txHash);
  });

  it("refuses values nearcore cannot hold instead of truncating them", () => {
    const k = newKey();
    const base = { signerId: RELAYER, publicKey: k.publicKey, receiverId: ESCROW, blockHash: BLOCK };
    expect(() =>
      encodeTransaction({ ...base, nonce: 1n << 64n, actions: [{ kind: "Transfer", depositYocto: 1n }] }),
    ).toThrow(/u64/);
    expect(() =>
      encodeTransaction({ ...base, nonce: 1n, actions: [{ kind: "Transfer", depositYocto: 1n << 128n }] }),
    ).toThrow(/u128/);
    expect(() => encodeTransaction({ ...base, nonce: 1n, actions: [] })).toThrow(/at least one action/);
    expect(() =>
      encodeTransaction({
        ...base,
        signerId: "Bad Account",
        nonce: 1n,
        actions: [{ kind: "CreateAccount" }],
      }),
    ).toThrow(/account id/);
    expect(() =>
      encodeTransaction({ ...base, blockHash: "abc", nonce: 1n, actions: [{ kind: "CreateAccount" }] }),
    ).toThrow(/32 bytes/);
  });
});

describe("M43 KeyFileTxSigner (relayer function-call key from a near-cli-rs key file)", () => {
  const load = (keyFilePath: string, accountId = RELAYER) =>
    KeyFileTxSigner.load({ accountId, receiverId: ESCROW, keyFile: keyFilePath, aclReader: okAcl });

  it("implements the TxSigner contract of the simulated signer: signerId, publicKey, sign → {txHash, signerId, encoded}", async () => {
    const k = newKey();
    const s = load(keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 }));
    expect(s.signerId).toBe(RELAYER);
    expect(s.publicKey).toBe(k.publicKey);
    const signed = await s.sign(CALL, { nonce: 7n, blockHash: BLOCK });
    expect(Object.keys(signed).sort()).toEqual(["encoded", "signerId", "txHash"]);
    expect(signed.signerId).toBe(RELAYER);
    const d = decodeSignedFunctionCall(signed.encoded);
    expect(d).toMatchObject({
      signerId: RELAYER,
      publicKey: k.publicKey,
      nonce: 7n,
      receiverId: ESCROW,
      blockHash: BLOCK,
      methodName: "execute_release",
      args: CALL.args,
      gas: 150_000_000_000_000n,
      deposit: 0n,
    });
    const digest = createHash("sha256").update(d.body).digest();
    expect(signed.txHash).toBe(base58Encode(digest));
    // The signature over the transaction hash verifies with the relayer key.
    expect(verify(null, digest, k.privateKey, d.signature)).toBe(true);
    // Same input, same transaction (an idempotent re-broadcast is the identical transaction).
    expect(await s.sign(CALL, { nonce: 7n, blockHash: BLOCK })).toEqual(signed);
  });

  it("accepts a 32-byte seed and the legacy secret_key field", async () => {
    const k = newKey();
    const a = load(keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret32 }));
    const b = load(keyFile({ account_id: RELAYER, public_key: k.publicKey, secret_key: k.secret64 }));
    const ref = { nonce: 1n, blockHash: BLOCK };
    expect((await a.sign(CALL, ref)).txHash).toBe((await b.sign(CALL, ref)).txHash);
  });

  it("never exposes the private key through JSON, inspection or enumeration", () => {
    const k = newKey();
    const s = load(keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 }));
    const secretBody = k.secret64.slice(8);
    const seedBody = k.secret32.slice(8);
    for (const text of [
      JSON.stringify(s),
      inspect(s, { showHidden: true, depth: 5 }),
      String(Object.keys(s)),
    ]) {
      expect(text).not.toContain(secretBody);
      expect(text).not.toContain(seedBody);
    }
    expect(JSON.parse(JSON.stringify(s))).toEqual({
      signerId: RELAYER,
      publicKey: k.publicKey,
      receiverId: ESCROW,
    });
  });

  it("signs only escrow calls without a deposit", async () => {
    const k = newKey();
    const s = load(keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 }));
    const ref = { nonce: 1n, blockHash: BLOCK };
    await expect(s.sign({ ...CALL, receiverId: "other.testnet" }, ref)).rejects.toMatchObject({
      code: "WRONG_CONTRACT",
    });
    await expect(s.sign({ ...CALL, methodName: "fund", depositYocto: "1" }, ref)).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    await expect(s.sign(CALL, { nonce: 0n, blockHash: BLOCK })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("refuses wrong account, mismatched halves, other key types and malformed files with a reason code", () => {
    const k = newKey();
    const other = newKey();
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (
          (e as { code: string; details: { reason: string } }).code +
          ":" +
          (e as { details: { reason: string } }).details.reason
        );
      }
      return "accepted";
    };
    expect(
      reason(() =>
        load(keyFile({ account_id: "someone.testnet", public_key: k.publicKey, private_key: k.secret64 })),
      ),
    ).toBe("CONFIG_INVALID:WRONG_ACCOUNT");
    expect(
      reason(() =>
        load(keyFile({ account_id: RELAYER, public_key: other.publicKey, private_key: k.secret64 })),
      ),
    ).toBe("CONFIG_INVALID:KEY_MISMATCH");
    expect(
      reason(() =>
        load(keyFile({ account_id: RELAYER, public_key: "secp256k1:abc", private_key: "secp256k1:abc" })),
      ),
    ).toBe("CONFIG_INVALID:KEY_TYPE");
    expect(reason(() => load(keyFile({ account_id: RELAYER, public_key: k.publicKey })))).toBe(
      "CONFIG_INVALID:MALFORMED",
    );
    const notJson = join(dir, "not-json.json");
    writeFileSync(notJson, "ed25519 key", { mode: 0o600 });
    expect(reason(() => load(notJson))).toBe("CONFIG_INVALID:MALFORMED");
    expect(reason(() => load(join(dir, "absent.json")))).toBe("CONFIG_INVALID:MISSING");
    const big = join(dir, "big.json");
    writeFileSync(big, "x".repeat(5000), { mode: 0o600 });
    expect(reason(() => load(big))).toBe("CONFIG_INVALID:TOO_LARGE");
    // A key file inside a git working tree (for example the repository) is refused.
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const inRepo = join(repo, "relayer.json");
    writeFileSync(
      inRepo,
      JSON.stringify({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 }),
      {
        mode: 0o600,
      },
    );
    expect(reason(() => load(inRepo))).toBe("CONFIG_INVALID:IN_REPOSITORY");
  });

  it("refuses a key file other local users can read (POSIX mode bits, Windows ACL entries)", () => {
    const k = newKey();
    const f = keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 });
    // Windows: an Everyone, Users or Authenticated Users entry on the ACL.
    for (const acl of [
      `${f} Everyone:(R)\n`,
      `${f} BUILTIN\\Users:(I)(RX)\n`,
      `${f} NT AUTHORITY\\Authenticated Users:(I)(M)\n`,
    ])
      expect(() => checkKeyFilePermissions(f, () => acl, "win32")).toThrow(/other local users/);
    expect(() => checkKeyFilePermissions(f, okAcl, "win32")).not.toThrow();
    if (process.platform !== "win32") {
      chmodSync(f, 0o644);
      expect(() => checkKeyFilePermissions(f)).toThrow(/owner only/);
      chmodSync(f, 0o600);
      expect(() => checkKeyFilePermissions(f)).not.toThrow();
      const link = join(dir, "link.json");
      symlinkSync(f, link);
      expect(() => checkKeyFilePermissions(link)).toThrow(/symbolic link/);
    }
  });

  it.skipIf(process.platform !== "win32")("reads the real Windows ACL of a key file with icacls", () => {
    const k = newKey();
    const f = keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 });
    // A file in the user's own temporary directory inherits an owner-only ACL.
    expect(() => checkKeyFilePermissions(f)).not.toThrow();
  });

  it("checks on chain that the key is a function-call key restricted to the escrow", async () => {
    const k = newKey();
    const s = load(keyFile({ account_id: RELAYER, public_key: k.publicKey, private_key: k.secret64 }));
    const view = (v: object) => ({ viewAccessKey: async () => v as never });
    await expect(
      s.verifyOnChain(
        view({
          permission: "FunctionCall",
          nonce: 9n,
          blockHeight: 5,
          functionCall: { receiverId: ESCROW, methodNames: [], allowanceYocto: 10n ** 24n },
        }),
      ),
    ).resolves.toEqual({ nonce: 9n, blockHeight: 5 });
    await expect(
      s.verifyOnChain(view({ permission: "FullAccess", nonce: 1n, blockHeight: 5 })),
    ).rejects.toMatchObject({
      details: { reason: "FULL_ACCESS_KEY" },
    });
    await expect(
      s.verifyOnChain(
        view({
          permission: "FunctionCall",
          nonce: 1n,
          blockHeight: 5,
          functionCall: { receiverId: "other.testnet", methodNames: [], allowanceYocto: null },
        }),
      ),
    ).rejects.toMatchObject({ details: { reason: "WRONG_RECEIVER" } });
    const { DocksideError } = await import("@dockside/core");
    await expect(
      s.verifyOnChain({
        viewAccessKey: async () => {
          throw new DocksideError("NOT_FOUND", "not found");
        },
      }),
    ).rejects.toMatchObject({ details: { reason: "KEY_NOT_ON_CHAIN" } });
  });
});

describe("M43 chain preflight", () => {
  const HASH = "7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N";
  const manifest = join(dir, "build-manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({ contract: { nearCodeHash: HASH }, deployment: { accountId: null } }),
  );
  const fake = (o: { chainId?: string; codeHash?: string; network?: string } = {}) => ({
    request: async () => ({ chain_id: o.chainId ?? "testnet" }) as never,
    viewAccount: async () =>
      ({
        amountYocto: 1n,
        lockedYocto: 0n,
        codeHash: o.codeHash ?? HASH,
        storageUsage: 1,
        blockHeight: 77,
      }) as never,
    callView: async () =>
      ({
        value: { network: o.network ?? "near-testnet" },
        logs: [],
        blockHeight: 77,
        blockHash: BLOCK,
      }) as never,
  });
  const run = (
    rpc = fake(),
    extra: Partial<{ rpcUrl: string; escrowId: string; expectedChainId: string }> = {},
  ) =>
    preflightEscrow({
      rpc,
      rpcUrl: extra.rpcUrl ?? "https://rpc.testnet.near.org",
      escrowId: extra.escrowId ?? ESCROW,
      manifestPath: manifest,
      expectedChainId: extra.expectedChainId ?? "testnet",
    });

  it("passes when the node is testnet and the escrow runs exactly the manifest's code", async () => {
    await expect(run()).resolves.toEqual({
      chainId: "testnet",
      escrowId: ESCROW,
      codeHash: HASH,
      contractNetwork: "near-testnet",
      blockHeight: 77,
    });
  });

  it("refuses mainnet in every form", async () => {
    await expect(run(fake({ chainId: "mainnet" }))).rejects.toMatchObject({
      details: { reason: "MAINNET_REFUSED" },
    });
    await expect(run(fake(), { rpcUrl: "https://rpc.mainnet.near.org" })).rejects.toMatchObject({
      details: { reason: "MAINNET_REFUSED" },
    });
    await expect(run(fake(), { expectedChainId: "mainnet" })).rejects.toMatchObject({
      details: { reason: "MAINNET_REFUSED" },
    });
    await expect(run(fake(), { escrowId: "dockside.near" })).rejects.toMatchObject({
      details: { reason: "NOT_TESTNET_ACCOUNT" },
    });
  });

  it("refuses a different code hash, another chain and a contract initialised for another network", async () => {
    await expect(run(fake({ codeHash: "11111111111111111111111111111111" }))).rejects.toMatchObject({
      details: { reason: "CODE_HASH_MISMATCH" },
    });
    await expect(run(fake({ chainId: "localnet" }))).rejects.toMatchObject({
      details: { reason: "CHAIN_ID_MISMATCH" },
    });
    await expect(run(fake({ network: "near-mainnet" }))).rejects.toMatchObject({
      details: { reason: "CONTRACT_NETWORK_MISMATCH" },
    });
    // A sandbox chain id is accepted only on a loopback RPC.
    await expect(run(fake({ chainId: "sandbox" }), { expectedChainId: "sandbox" })).rejects.toMatchObject({
      details: { reason: "CHAIN_ID_NOT_LOCAL" },
    });
    await expect(
      run(fake({ chainId: "sandbox" }), { expectedChainId: "sandbox", rpcUrl: "http://127.0.0.1:3030" }),
    ).resolves.toMatchObject({ chainId: "sandbox" });
  });

  it("reads the code hash from a build manifest or an artifact record, and refuses a manifest of another account", () => {
    expect(manifestCodeHash(manifest, ESCROW)).toBe(HASH);
    const artifact = join(dir, "artifact.json");
    writeFileSync(artifact, JSON.stringify({ nearCodeHash: HASH, sha256: "x" }));
    expect(manifestCodeHash(artifact, ESCROW)).toBe(HASH);
    const other = join(dir, "other.json");
    writeFileSync(
      other,
      JSON.stringify({ contract: { nearCodeHash: HASH }, deployment: { accountId: "x.testnet" } }),
    );
    expect(() => manifestCodeHash(other, ESCROW)).toThrow(/another deployment/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ contract: { nearCodeHash: "nope" } }));
    expect(() => manifestCodeHash(bad, ESCROW)).toThrow(/no NEAR code hash/);
    expect(() => manifestCodeHash(join(dir, "absent-manifest.json"), ESCROW)).toThrow(/missing/);
  });
});
