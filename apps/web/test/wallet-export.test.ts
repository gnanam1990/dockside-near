/**
 * M17 browser libraries against the backend implementations: the NEP-413 Borsh payload the
 * connector checks equals @dockside/core's, a wallet answer is verified with WebCrypto before it is
 * sent, and the in-browser signed-export check agrees with the offline verifier on valid and
 * tampered bundles.
 */
import { verifyAuditExport, verifySignedAuditExport } from "@dockside/api";
import {
  type CanonicalValue,
  digestHexFor,
  generateEd25519KeyPair,
  nep413Bytes as coreNep413Bytes,
  signFor,
  signNep413,
} from "@dockside/core";
import { describe, expect, it } from "vitest";
import { verifySignedExportInBrowser } from "../src/lib/export-verify";
import { checkWalletAnswer, connectorFromWallet, nep413Bytes, walletSignatureBytes } from "../src/lib/wallet";

const nonce = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
const req = {
  message: "Dockside NEAR account link\naccount: a.testnet",
  nonce,
  recipient: "https://dockside.test",
};

describe("wallet connector boundary (NEP-413)", () => {
  it("serialises the NEP-413 payload byte for byte like @dockside/core", () => {
    expect(Buffer.from(nep413Bytes(req)).equals(Buffer.from(coreNep413Bytes(req)))).toBe(true);
    expect(() => nep413Bytes({ ...req, nonce: new Uint8Array(31) })).toThrow(/32 bytes/);
  });

  it("accepts a real NEP-413 signature (base64 or ed25519 form) and refuses everything else", async () => {
    const k = generateEd25519KeyPair();
    const sig = signNep413(k.privateKey, req);
    const b64 = Buffer.from(walletSignatureBytes(sig)).toString("base64");
    const answer = { accountId: "a.testnet", publicKey: k.publicKey, signature: b64 };
    expect(await checkWalletAnswer(req, "a.testnet", answer)).toEqual({ ok: true });
    expect(await checkWalletAnswer(req, "a.testnet", { ...answer, signature: sig })).toEqual({ ok: true });
    expect((await checkWalletAnswer(req, "b.testnet", answer)).ok).toBe(false);
    expect(
      (await checkWalletAnswer({ ...req, recipient: "https://phish.test" }, "a.testnet", answer)).ok,
    ).toBe(false);
    expect(
      (
        await checkWalletAnswer(req, "a.testnet", {
          ...answer,
          publicKey: generateEd25519KeyPair().publicKey,
        })
      ).ok,
    ).toBe(false);
    expect((await checkWalletAnswer(req, "a.testnet", { ...answer, signature: "x" })).ok).toBe(false);
  });

  it("wraps a wallet-selector style signMessage and refuses an empty answer", async () => {
    const c = connectorFromWallet("w", "Wallet", { signMessage: async () => undefined });
    await expect(c.signMessage(req)).rejects.toThrow(/no signature/);
  });
});

describe("in-browser signed export check agrees with the offline verifier", () => {
  const key = generateEd25519KeyPair();
  const body = {
    schema: "dockside/audit-export@1",
    checksumAlgorithm: "sha256/dockside-stable-json@1",
    tradeId: `trd_${"a".repeat(32)}`,
    generatedAt: 1_800_000_000_000,
    exportedBy: {
      principalId: `prn_${"b".repeat(32)}`,
      keyVersionId: `key_${"c".repeat(32)}`,
      organizationId: `org_${"d".repeat(32)}`,
    },
    sections: { holds: [{ id: "h1", status: "RESOLVED" }], operations: [] },
    chain: { source: "escrow-contract-view", trade: null },
    integrity: { auditChain: { ok: true, count: 3 }, auditHeadHash: "ef".repeat(32) },
    destinations: "MASKED",
    exclusions: [{ item: "x", reason: "y" }],
  };
  const ex = { ...body, checksum: verifyAuditExport({ ...body, checksum: "" }).expected };
  const statement = {
    schema: "dockside/audit-export-statement@1",
    exportSchema: ex.schema,
    checksumAlgorithm: ex.checksumAlgorithm,
    exportChecksum: ex.checksum,
    tradeId: ex.tradeId,
    generatedAt: ex.generatedAt,
    exportedBy: ex.exportedBy,
    destinations: ex.destinations,
    auditHeadHash: ex.integrity.auditHeadHash,
    origin: "https://dockside.test",
    network: "near-testnet",
    keyId: `aek_${"e".repeat(32)}`,
    publicKey: key.publicKey,
    signedAt: 1_800_000_000_500,
  };
  const bundle = {
    schema: "dockside/signed-audit-export@1",
    export: ex,
    statement,
    statementDigest: digestHexFor("AUDIT_EXPORT", statement as CanonicalValue),
    signature: signFor(key.privateKey, "AUDIT_EXPORT", statement as CanonicalValue),
  };
  const keys = [
    {
      keyId: statement.keyId,
      publicKey: key.publicKey,
      origin: "https://dockside.test",
      network: "near-testnet",
      status: "ACTIVE" as const,
      enrolledAt: 1_700_000_000_000,
      retiredAt: null,
      revokedAt: null,
    },
  ];
  const variants: [string, (b: any) => void][] = [
    ["valid", () => undefined],
    ["section edited", (b) => (b.export.sections.holds[0].status = "ACTIVE")],
    ["statement edited", (b) => (b.statement.destinations = "FULL")],
    [
      "signature swapped",
      (b) => (b.signature = signFor(generateEd25519KeyPair().privateKey, "AUDIT_EXPORT", b.statement)),
    ],
    ["audit head changed", (b) => (b.export.integrity.auditHeadHash = "00".repeat(32))],
  ];
  for (const [name, f] of variants)
    it(`${name}: browser and offline verifier give the same verdict`, async () => {
      const b = JSON.parse(JSON.stringify(bundle));
      f(b);
      const offline = verifySignedAuditExport(b, keys).ok;
      const browser = (await verifySignedExportInBrowser(b, keys)).ok;
      expect(browser).toBe(offline);
      expect(offline).toBe(name === "valid");
    });
  it("a revoked key fails in both", async () => {
    const revoked = [{ ...keys[0], status: "REVOKED" as const, revokedAt: 1_800_000_000_600 }];
    expect(verifySignedAuditExport(bundle, revoked as never).ok).toBe(false);
    expect((await verifySignedExportInBrowser(bundle, revoked as never)).ok).toBe(false);
  });
});
