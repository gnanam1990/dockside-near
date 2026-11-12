import { base58Decode, base58Encode } from "./base58";
import { sha256 } from "./canonical";

/**
 * Browser wallet-connector boundary (ADR-0017). A connector signs NEP-413 messages with the
 * user's NEAR wallet; Dockside never sees the wallet's private key.
 *
 * The request and answer shapes equal the `signMessage` contract of NEAR wallets and of
 * `@near-wallet-selector/core` (`{message, recipient, nonce}` -> `{accountId, publicKey,
 * signature}`, signature = base64 of the raw 64-byte Ed25519 signature), so a wallet-selector
 * wallet instance can be wrapped with `connectorFromWallet` without this build depending on it.
 *
 * Discovery: an injected wallet announces itself with a `near-wallet:announce` window event whose
 * `detail` is a WalletConnector; the page asks with `near-wallet:request`. No wallet is bundled.
 */
export interface Nep413Request {
  readonly message: string;
  /** Exactly 32 bytes, issued by the server. */
  readonly nonce: Uint8Array;
  /** The relying party: this Dockside origin. */
  readonly recipient: string;
}

export interface Nep413SignedMessage {
  readonly accountId: string;
  readonly publicKey: string;
  /** base64 of the raw signature, or `ed25519:<base58>`. */
  readonly signature: string;
}

export interface WalletConnector {
  readonly id: string;
  readonly name: string;
  signMessage(request: Nep413Request): Promise<Nep413SignedMessage>;
}

export const ANNOUNCE_EVENT = "near-wallet:announce";
export const REQUEST_EVENT = "near-wallet:request";

function isConnector(v: unknown): v is WalletConnector {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c["id"] === "string" &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(c["id"]) &&
    typeof c["name"] === "string" &&
    c["name"].length <= 80 &&
    typeof c["signMessage"] === "function"
  );
}

/** Ask injected wallets to announce themselves; resolves with every distinct one seen in time. */
export function discoverWallets(timeoutMs = 300): Promise<WalletConnector[]> {
  return new Promise((resolve) => {
    const found = new Map<string, WalletConnector>();
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (isConnector(detail) && !found.has(detail.id)) found.set(detail.id, detail);
    };
    window.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    window.dispatchEvent(new Event(REQUEST_EVENT));
    window.setTimeout(() => {
      window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/** Wrap any object with a wallet-selector style `signMessage` (e.g. a wallet-selector Wallet). */
export function connectorFromWallet(
  id: string,
  name: string,
  wallet: {
    signMessage(p: {
      message: string;
      recipient: string;
      nonce: Uint8Array;
    }): Promise<Nep413SignedMessage | undefined | null>;
  },
): WalletConnector {
  return {
    id,
    name,
    async signMessage(r) {
      const out = await wallet.signMessage({ message: r.message, recipient: r.recipient, nonce: r.nonce });
      if (!out)
        throw new Error("the wallet returned no signature (it may have redirected or been cancelled)");
      return out;
    },
  };
}

/* ------------------------------ NEP-413 encoding ------------------------------ */

const NEP413_TAG = 2 ** 31 + 413;

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

function borshString(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return concat([u32(b.length), b]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Borsh(tag u32 || message || nonce[32] || recipient || callbackUrl: None), as wallets sign. */
export function nep413Bytes(r: Nep413Request): Uint8Array {
  if (r.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  return concat([
    u32(NEP413_TAG),
    borshString(r.message),
    r.nonce,
    borshString(r.recipient),
    new Uint8Array([0]),
  ]);
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Raw signature bytes from either wallet form. */
export function walletSignatureBytes(sig: string): Uint8Array {
  if (sig.startsWith("ed25519:")) return base58Decode(sig.slice(8));
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sig)) throw new Error("signature is not base64 or ed25519:<base58>");
  return base64ToBytes(sig);
}

const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * Check a wallet's answer in the browser before sending it: well-formed fields, the account the
 * challenge names, and an Ed25519 signature that verifies over the exact NEP-413 payload. The server
 * repeats every check and also asks the chain whether the key is a full-access key of the account.
 */
export async function checkWalletAnswer(
  request: Nep413Request,
  expectedAccountId: string,
  answer: Nep413SignedMessage,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (typeof answer?.accountId !== "string" || answer.accountId !== expectedAccountId)
    return {
      ok: false,
      reason: `the wallet answered for ${String(answer?.accountId)}, not ${expectedAccountId}`,
    };
  if (typeof answer.publicKey !== "string" || !PUBLIC_KEY.test(answer.publicKey))
    return { ok: false, reason: "the wallet returned a malformed public key" };
  let sig: Uint8Array;
  let raw: Uint8Array;
  try {
    sig = walletSignatureBytes(String(answer.signature));
    raw = base58Decode(answer.publicKey.slice(8));
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (sig.length !== 64 || raw.length !== 32 || `ed25519:${base58Encode(raw)}` !== answer.publicKey)
    return { ok: false, reason: "the wallet returned a malformed signature or key" };
  const key = await crypto.subtle.importKey("raw", copy(raw), { name: "Ed25519" }, false, ["verify"]);
  const digest = await sha256(nep413Bytes(request));
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, copy(sig), copy(digest));
  return ok
    ? { ok: true }
    : { ok: false, reason: "the wallet's signature does not verify over this message" };
}

function copy(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}
