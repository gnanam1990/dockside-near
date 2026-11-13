import { createHash, type KeyObject, sign } from "node:crypto";
import { base58Decode, base58Encode, fail, publicKeyBytes } from "@dockside/core";

/**
 * NEAR transaction wire format (borsh, nearcore `Transaction::V0` and `SignedTransaction`), written
 * here with node:crypto only so that no third-party code ever sees a relayer key (M43).
 *
 *   Transaction  = signer_id: string, public_key: PublicKey, nonce: u64, receiver_id: string,
 *                  block_hash: [u8; 32], actions: Vec<Action>
 *   PublicKey    = u8 key type (0 = ED25519) ++ 32 bytes
 *   Signature    = u8 key type (0 = ED25519) ++ 64 bytes
 *   SignedTx     = Transaction ++ Signature
 *   tx hash      = base58(sha256(borsh(Transaction))); the signature is over the 32-byte hash.
 *
 * Strings are u32-LE-length-prefixed UTF-8, vectors u32-LE-count-prefixed, integers little endian.
 * Only the actions Dockside needs are encodable; anything else is refused rather than guessed.
 */

export type NearAction =
  | { readonly kind: "CreateAccount" }
  | { readonly kind: "DeployContract"; readonly code: Uint8Array }
  | {
      readonly kind: "FunctionCall";
      readonly methodName: string;
      readonly args: Uint8Array;
      readonly gas: bigint;
      readonly depositYocto: bigint;
    }
  | { readonly kind: "Transfer"; readonly depositYocto: bigint }
  | {
      readonly kind: "AddKey";
      readonly publicKey: string;
      readonly permission:
        | { readonly kind: "FullAccess" }
        | {
            readonly kind: "FunctionCall";
            readonly allowanceYocto: bigint | null;
            readonly receiverId: string;
            readonly methodNames: readonly string[];
          };
    }
  | { readonly kind: "DeleteKey"; readonly publicKey: string };

export interface NearTransaction {
  readonly signerId: string;
  readonly publicKey: string;
  readonly nonce: bigint;
  readonly receiverId: string;
  /** base58 hash of a recent block; the transaction is valid for the network's validity period after it. */
  readonly blockHash: string;
  readonly actions: readonly NearAction[];
}

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
/** nearcore's account id length limit; the signer refuses anything longer before encoding. */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

class Writer {
  private readonly parts: Buffer[] = [];
  u8(v: number): void {
    this.parts.push(Buffer.from([v & 0xff]));
  }
  u32(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) fail("VALIDATION_FAILED", "u32 out of range");
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.parts.push(b);
  }
  u64(v: bigint): void {
    if (v < 0n || v > U64_MAX) fail("VALIDATION_FAILED", "u64 out of range");
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v, 0);
    this.parts.push(b);
  }
  u128(v: bigint): void {
    if (v < 0n || v > U128_MAX) fail("INVALID_AMOUNT", "u128 out of range");
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & U64_MAX, 0);
    b.writeBigUInt64LE(v >> 64n, 8);
    this.parts.push(b);
  }
  bytes(v: Uint8Array): void {
    this.u32(v.length);
    this.parts.push(Buffer.from(v));
  }
  fixed(v: Uint8Array): void {
    this.parts.push(Buffer.from(v));
  }
  string(v: string): void {
    this.bytes(Buffer.from(v, "utf8"));
  }
  out(): Buffer {
    return Buffer.concat(this.parts);
  }
}

function accountId(v: string, what: string): string {
  if (typeof v !== "string" || v.length < 2 || v.length > 64 || !ACCOUNT_RE.test(v))
    fail("INVALID_ADDRESS", `${what} is not a NEAR account id`);
  return v;
}

function writePublicKey(w: Writer, pk: string): void {
  w.u8(0); // ED25519
  w.fixed(publicKeyBytes(pk));
}

function writeAction(w: Writer, a: NearAction): void {
  switch (a.kind) {
    case "CreateAccount":
      w.u8(0);
      return;
    case "DeployContract":
      w.u8(1);
      w.bytes(a.code);
      return;
    case "FunctionCall":
      if (a.methodName.length === 0 || a.methodName.length > 256)
        fail("VALIDATION_FAILED", "method name length out of range");
      w.u8(2);
      w.string(a.methodName);
      w.bytes(a.args);
      w.u64(a.gas);
      w.u128(a.depositYocto);
      return;
    case "Transfer":
      w.u8(3);
      w.u128(a.depositYocto);
      return;
    case "AddKey":
      w.u8(5);
      writePublicKey(w, a.publicKey);
      w.u64(0n); // AccessKey.nonce: nearcore sets the real starting nonce itself
      if (a.permission.kind === "FullAccess") {
        w.u8(1);
      } else {
        w.u8(0);
        if (a.permission.allowanceYocto === null) w.u8(0);
        else {
          w.u8(1);
          w.u128(a.permission.allowanceYocto);
        }
        w.string(accountId(a.permission.receiverId, "function-call key receiver"));
        w.u32(a.permission.methodNames.length);
        for (const m of a.permission.methodNames) w.string(m);
      }
      return;
    case "DeleteKey":
      w.u8(6);
      writePublicKey(w, a.publicKey);
      return;
  }
}

/** Borsh bytes of the unsigned transaction (what the hash and signature cover). */
export function encodeTransaction(tx: NearTransaction): Uint8Array {
  const w = new Writer();
  w.string(accountId(tx.signerId, "signer"));
  writePublicKey(w, tx.publicKey);
  w.u64(tx.nonce);
  w.string(accountId(tx.receiverId, "receiver"));
  let hash: Uint8Array;
  try {
    hash = base58Decode(tx.blockHash);
  } catch {
    fail("VALIDATION_FAILED", "block hash is not base58");
  }
  if (hash.length !== 32) fail("VALIDATION_FAILED", "block hash must be 32 bytes");
  w.fixed(hash);
  if (tx.actions.length === 0) fail("VALIDATION_FAILED", "a transaction needs at least one action");
  w.u32(tx.actions.length);
  for (const a of tx.actions) writeAction(w, a);
  return new Uint8Array(w.out());
}

export interface SignedNearTransaction {
  /** base58 sha256 of the unsigned transaction bytes: the id nearcore reports for it. */
  readonly txHash: string;
  /** base64 of the borsh SignedTransaction, exactly what `send_tx` broadcasts. */
  readonly encoded: string;
}

/**
 * Sign with an Ed25519 key held as a node:crypto KeyObject. Ed25519 is deterministic, so the same
 * transaction always yields the same bytes and hash: a re-broadcast of a persisted transaction is
 * the identical transaction, never a second one.
 */
export function signTransaction(privateKey: KeyObject, tx: NearTransaction): SignedNearTransaction {
  const body = encodeTransaction(tx);
  const digest = createHash("sha256").update(body).digest();
  const signature = sign(null, digest, privateKey);
  if (signature.length !== 64) fail("INVALID_KEY", "not an Ed25519 signing key");
  const encoded = Buffer.concat([Buffer.from(body), Buffer.from([0]), signature]).toString("base64");
  return { txHash: base58Encode(digest), encoded };
}

/** Function-call action from Dockside's `FunctionCall` shape (JSON args, decimal gas and deposit). */
export function functionCallAction(call: {
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  readonly gas: string;
  readonly depositYocto: string;
}): NearAction {
  if (!/^[1-9][0-9]{0,19}$/.test(call.gas)) fail("VALIDATION_FAILED", "gas must be a positive integer");
  if (!/^(0|[1-9][0-9]{0,38})$/.test(call.depositYocto))
    fail("INVALID_AMOUNT", "deposit must be a non-negative integer");
  return {
    kind: "FunctionCall",
    methodName: call.methodName,
    args: new Uint8Array(Buffer.from(JSON.stringify(call.args), "utf8")),
    gas: BigInt(call.gas),
    depositYocto: BigInt(call.depositYocto),
  };
}
