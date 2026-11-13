import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspect } from "node:util";
import {
  base58Decode,
  base58Encode,
  DocksideError,
  exportPublicKey,
  fail,
  parsePublicKey,
} from "@dockside/core";
import type { FunctionCall } from "./escrow.js";
import { functionCallAction, signTransaction } from "./near-tx.js";
import type { NearRpc } from "./rpc.js";
import type { SignedTx, TxSigner } from "./tx.js";

/**
 * Production relayer `TxSigner` (M43): signs NEAR transactions with the relayer's FUNCTION-CALL
 * access key, which the owner restricted to the Dockside escrow on chain.
 *
 * Custody rules (SECURITY.md, ADR-0003, USER-NEXT-STEPS §4):
 * - The key comes only from a near-cli-rs key file the owner keeps outside any repository (the
 *   legacy keychain `~/.near-credentials/<network>/<account>/<key>.json` or a file near-cli-rs
 *   saved with `save-to-legacy-keychain` / `sign-with-access-key-file`). Only the file PATH is
 *   configuration (`DOCKSIDE_RELAYER_KEY_FILE`); the key itself is never in an environment
 *   variable, the database, a log line or an HTTP message.
 * - The file must be a regular file (no symlink), at most 4 KiB, not inside a git working tree,
 *   and readable by its owner only: POSIX mode `0600`/`0400` owned by this user; on Windows no
 *   ACL entry for Everyone, Users or Authenticated Users (checked with `icacls`).
 * - The private key lives in a non-exportable-by-this-API `KeyObject` held in a private field;
 *   `toJSON` and `util.inspect` show only the account and public key.
 * - Every signature is a function call to the configured escrow with no attached deposit: a
 *   function-call key cannot attach one, and a call to another receiver is refused before signing.
 *
 * Nonces and block hashes come from the caller (the journal's `withRelayerKey` lease allocates the
 * nonce from `view_access_key` and the durable nonce table), exactly as for the simulated signer:
 * `sign(call, { nonce, blockHash })` returns `{ txHash, signerId, encoded }`, and signing the same
 * input twice returns the same bytes and hash.
 */

const MAX_KEY_FILE_BYTES = 4096;
/** Windows principals whose presence on a key file's ACL means other local users can read it. */
const BROAD_PRINCIPALS = [/\bEveryone:/i, /\\Users:/i, /\bAuthenticated Users:/i, /^\s*Users:/i];

export interface KeyFileSignerOptions {
  /** The relayer account the key file must belong to. */
  readonly accountId: string;
  /** The escrow contract: the only receiver this signer signs for. */
  readonly receiverId: string;
  /** Path of the near-cli-rs key file. */
  readonly keyFile: string;
  /** Test seam for the Windows ACL check; production uses `icacls`. */
  readonly aclReader?: (path: string) => string;
}

/** Why a key file was refused, without any key material. */
function refuse(reason: string, message: string): never {
  fail("CONFIG_INVALID", `relayer key file refused: ${message}`, { reason });
}

function insideGitWorkTree(path: string): boolean {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function defaultAclReader(path: string): string {
  const r = spawnSync("icacls", [resolve(path)], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (r.status !== 0) refuse("ACL_UNREADABLE", "icacls could not read the file's access control list");
  return r.stdout;
}

/** Permission checks; throws CONFIG_INVALID with a reason code. */
export function checkKeyFilePermissions(
  path: string,
  aclReader: (path: string) => string = defaultAclReader,
  platform: NodeJS.Platform = process.platform,
): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    refuse("MISSING", "the configured key file does not exist");
  }
  if (st.isSymbolicLink()) refuse("SYMLINK", "the key file must not be a symbolic link");
  if (!st.isFile()) refuse("NOT_A_FILE", "the key file must be a regular file");
  if (st.size > MAX_KEY_FILE_BYTES) refuse("TOO_LARGE", "the key file is larger than a key file can be");
  if (insideGitWorkTree(path)) refuse("IN_REPOSITORY", "the key file must not be inside a git working tree");
  if (platform === "win32") {
    const acl = aclReader(path);
    for (const line of acl.split(/\r?\n/).map((l) => l.replace(resolve(path), "")))
      if (BROAD_PRINCIPALS.some((re) => re.test(line)))
        refuse("PERMISSIONS_TOO_OPEN", "other local users can read the key file (Everyone/Users ACL entry)");
    return;
  }
  if ((st.mode & 0o077) !== 0)
    refuse("PERMISSIONS_TOO_OPEN", "the key file must be readable by its owner only (chmod 600)");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) refuse("WRONG_OWNER", "the key file must be owned by this user");
}

function readSmall(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_KEY_FILE_BYTES) refuse("TOO_LARGE", "the key file is larger than a key file can be");
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** PKCS#8 DER for an Ed25519 seed. */
function keyFromSeed(seed: Uint8Array): KeyObject {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const der = Buffer.concat([prefix, Buffer.from(seed)]);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

/** Parse a near-cli-rs key file into the account, public key and private KeyObject. */
export function parseKeyFile(raw: Buffer): { accountId: string; publicKey: string; key: KeyObject } {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    refuse("MALFORMED", "the key file is not JSON");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    refuse("MALFORMED", "the key file is not a JSON object");
  const accountId = doc["account_id"];
  const publicKey = doc["public_key"];
  // near-cli-rs writes private_key; the legacy JS near-cli wrote secret_key.
  const secret = doc["private_key"] ?? doc["secret_key"];
  if (typeof accountId !== "string" || typeof publicKey !== "string" || typeof secret !== "string")
    refuse("MALFORMED", "the key file needs account_id, public_key and private_key");
  if (!secret.startsWith("ed25519:") || !publicKey.startsWith("ed25519:"))
    refuse("KEY_TYPE", "only ed25519 relayer keys are supported");
  let pk: string;
  try {
    pk = parsePublicKey(publicKey);
  } catch {
    refuse("MALFORMED", "public_key is not an ed25519 key");
  }
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(secret.slice("ed25519:".length));
  } catch {
    refuse("MALFORMED", "private_key is not base58");
  }
  try {
    if (bytes.length !== 64 && bytes.length !== 32) refuse("MALFORMED", "private_key has the wrong length");
    const key = keyFromSeed(bytes.subarray(0, 32));
    const derived = exportPublicKey(createPublicKey(key));
    if (derived !== pk) refuse("KEY_MISMATCH", "private_key does not belong to public_key");
    if (bytes.length === 64 && `ed25519:${base58Encode(bytes.subarray(32))}` !== pk)
      refuse("KEY_MISMATCH", "private_key's public half differs from public_key");
    return { accountId, publicKey: pk, key };
  } finally {
    bytes.fill(0);
  }
}

export class KeyFileTxSigner implements TxSigner {
  readonly signerId: string;
  readonly publicKey: string;
  readonly receiverId: string;
  readonly #key: KeyObject;

  private constructor(signerId: string, publicKey: string, receiverId: string, key: KeyObject) {
    this.signerId = signerId;
    this.publicKey = publicKey;
    this.receiverId = receiverId;
    this.#key = key;
  }

  /** Load and check the key file. Throws CONFIG_INVALID (with a reason code, never key material). */
  static load(opts: KeyFileSignerOptions): KeyFileTxSigner {
    checkKeyFilePermissions(opts.keyFile, opts.aclReader);
    const raw = readSmall(opts.keyFile);
    try {
      const k = parseKeyFile(raw);
      if (k.accountId !== opts.accountId)
        refuse("WRONG_ACCOUNT", "the key file belongs to another account than the configured relayer");
      return new KeyFileTxSigner(k.accountId, k.publicKey, opts.receiverId, k.key);
    } finally {
      raw.fill(0);
    }
  }

  /**
   * The key on chain must be a function-call key restricted to the escrow. A full-access key, a key
   * for another receiver or a missing key is refused: the relayer never holds more than it needs.
   */
  async verifyOnChain(rpc: Pick<NearRpc, "viewAccessKey">): Promise<{ nonce: bigint; blockHeight: number }> {
    let view: Awaited<ReturnType<NearRpc["viewAccessKey"]>>;
    try {
      view = await rpc.viewAccessKey(this.signerId, this.publicKey);
    } catch (e) {
      if (e instanceof DocksideError && e.code === "NOT_FOUND")
        fail("CONFIG_INVALID", "the relayer key is not an access key of the relayer account on chain", {
          reason: "KEY_NOT_ON_CHAIN",
        });
      throw e;
    }
    if (view.permission === "FullAccess")
      fail("CONFIG_INVALID", "the relayer key is a full-access key; use a function-call key for the escrow", {
        reason: "FULL_ACCESS_KEY",
      });
    if (!view.functionCall || view.functionCall.receiverId !== this.receiverId)
      fail("CONFIG_INVALID", "the relayer function-call key is not restricted to the escrow contract", {
        reason: "WRONG_RECEIVER",
      });
    return { nonce: view.nonce, blockHeight: view.blockHeight };
  }

  async sign(
    call: FunctionCall,
    ref: { readonly nonce: bigint; readonly blockHash: string },
  ): Promise<SignedTx> {
    if (call.receiverId !== this.receiverId)
      fail("WRONG_CONTRACT", "the relayer signs only calls to the configured escrow contract");
    if (call.depositYocto !== "0")
      fail(
        "INVALID_AMOUNT",
        "a function-call access key cannot attach a deposit; the party's own wallet must send it",
      );
    if (ref.nonce <= 0n) fail("VALIDATION_FAILED", "nonce must be positive");
    const signed = signTransaction(this.#key, {
      signerId: this.signerId,
      publicKey: this.publicKey,
      nonce: ref.nonce,
      receiverId: call.receiverId,
      blockHash: ref.blockHash,
      actions: [functionCallAction(call)],
    });
    return { txHash: signed.txHash, signerId: this.signerId, encoded: signed.encoded };
  }

  toJSON(): Record<string, string> {
    return { signerId: this.signerId, publicKey: this.publicKey, receiverId: this.receiverId };
  }

  [inspect.custom](): string {
    return `KeyFileTxSigner(${this.signerId} ${this.publicKey} -> ${this.receiverId})`;
  }
}
