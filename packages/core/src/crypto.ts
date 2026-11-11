import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import { type CanonicalValue, canonicalDigest, sha256 } from "./canonical.js";
import {
  encodePublicKey,
  encodeSignature,
  type PublicKeyString,
  publicKeyBytes,
  type SignatureString,
  signatureBytes,
} from "./codecs.js";
import { fail } from "./errors.js";

/**
 * Ed25519 primitives on node:crypto (no third-party crypto).
 * Keys use NEAR's textual form `ed25519:<base58>` so that a NEAR wallet key can be
 * enrolled directly. Private keys are held as opaque KeyObjects; there is
 * intentionally no API here that serialises a private key to text.
 */
export interface Ed25519KeyPair {
  readonly publicKey: PublicKeyString;
  readonly privateKey: KeyObject;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: exportPublicKey(publicKey), privateKey };
}

export function exportPublicKey(k: KeyObject): PublicKeyString {
  const jwk = k.export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") fail("INVALID_KEY", "not an Ed25519 key");
  return encodePublicKey(new Uint8Array(Buffer.from(jwk.x, "base64url")));
}

function publicKeyObject(pk: string): KeyObject {
  const raw = publicKeyBytes(pk);
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") },
    format: "jwk",
  });
}

export function publicKeyOf(privateKey: KeyObject): PublicKeyString {
  return exportPublicKey(createPublicKey(privateKey));
}

/** Import a 32-byte Ed25519 seed (used only by isolated signer processes and tests). */
export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) fail("INVALID_KEY", "ed25519 seed must be 32 bytes");
  // PKCS#8 DER prefix for an Ed25519 private key followed by the 32-byte seed.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}

export function signBytes(privateKey: KeyObject, message: Uint8Array): SignatureString {
  return encodeSignature(new Uint8Array(sign(null, message, privateKey)));
}

export function verifyBytes(publicKey: string, message: Uint8Array, signature: string): boolean {
  let sig: Uint8Array;
  let key: KeyObject;
  try {
    sig = signatureBytes(signature);
    key = publicKeyObject(publicKey);
  } catch {
    return false;
  }
  try {
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}

/** Sign a domain-separated canonical payload: Ed25519(SHA-256(envelope)). */
export function signCanonical(
  privateKey: KeyObject,
  domain: string,
  version: number,
  payload: CanonicalValue,
): SignatureString {
  return signBytes(privateKey, canonicalDigest(domain, version, payload));
}

export function verifyCanonical(
  publicKey: string,
  domain: string,
  version: number,
  payload: CanonicalValue,
  signature: string,
): boolean {
  return verifyBytes(publicKey, canonicalDigest(domain, version, payload), signature);
}

/* ------------------------------------------------------------------ */
/* NEP-413 (NEAR wallet signMessage)                                   */
/* ------------------------------------------------------------------ */

/** NEP-413 tag: 2^31 + 413. */
export const NEP413_TAG = 2147484061;

export interface Nep413Payload {
  readonly message: string;
  /** Exactly 32 bytes. */
  readonly nonce: Uint8Array;
  readonly recipient: string;
  readonly callbackUrl?: string;
}

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

/** Borsh-serialise the NEP-413 payload with its u32 tag prefix, exactly as NEAR wallets do. */
export function nep413Bytes(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) fail("VALIDATION_FAILED", "NEP-413 nonce must be 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG, 0);
  const cb =
    p.callbackUrl === undefined
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]);
  return new Uint8Array(
    Buffer.concat([tag, borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient), cb]),
  );
}

export function nep413Digest(p: Nep413Payload): Uint8Array {
  return sha256(nep413Bytes(p));
}

/** What a NEAR wallet does for signMessage: Ed25519 over SHA-256(borsh(tag || payload)). */
export function signNep413(privateKey: KeyObject, p: Nep413Payload): SignatureString {
  return signBytes(privateKey, nep413Digest(p));
}

export function verifyNep413(publicKey: string, p: Nep413Payload, signature: string): boolean {
  return verifyBytes(publicKey, nep413Digest(p), signature);
}
