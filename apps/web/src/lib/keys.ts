import { base58Encode } from "./base58";

/**
 * Device-held Ed25519 keys (WebCrypto). The private key is generated non-extractable,
 * so the browser can sign but no script, export or storage path can read the key
 * material (ADR-0003 flip condition, recorded in ADR-0008). Only the CryptoKey handle
 * is persisted in IndexedDB, scoped to this origin.
 */
export interface DeviceKeyRecord {
  /** NEAR textual form `ed25519:<base58>`; also the record id. */
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
  readonly label: string;
  readonly createdAt: number;
  /** Filled after the server confirms enrollment; never inferred locally. */
  readonly principalId: string | null;
  readonly organizationId: string | null;
}

export interface KeyStore {
  list(): Promise<DeviceKeyRecord[]>;
  get(publicKey: string): Promise<DeviceKeyRecord | undefined>;
  put(record: DeviceKeyRecord): Promise<void>;
  remove(publicKey: string): Promise<void>;
}

export async function generateDeviceKey(
  label: string,
  now: number,
): Promise<DeviceKeyRecord & { readonly extractable: boolean }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 32) throw new Error("unexpected Ed25519 public key length");
  return {
    publicKey: `ed25519:${base58Encode(raw)}`,
    privateKey: pair.privateKey,
    label,
    createdAt: now,
    principalId: null,
    organizationId: null,
    extractable: pair.privateKey.extractable,
  };
}

/** Ed25519 signature over raw bytes, in `ed25519:<base58>` form. */
export async function signBytes(privateKey: CryptoKey, message: Uint8Array): Promise<string> {
  const copy = new Uint8Array(message.byteLength);
  copy.set(message);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, copy));
  return `ed25519:${base58Encode(sig)}`;
}

export class MemoryKeyStore implements KeyStore {
  private readonly items = new Map<string, DeviceKeyRecord>();
  async list(): Promise<DeviceKeyRecord[]> {
    return [...this.items.values()];
  }
  async get(publicKey: string): Promise<DeviceKeyRecord | undefined> {
    return this.items.get(publicKey);
  }
  async put(record: DeviceKeyRecord): Promise<void> {
    this.items.set(record.publicKey, record);
  }
  async remove(publicKey: string): Promise<void> {
    this.items.delete(publicKey);
  }
}

const DB_NAME = "dockside-device-keys";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "publicKey" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
        t.oncomplete = () => db.close();
      }),
  );
}

export class IndexedDbKeyStore implements KeyStore {
  list(): Promise<DeviceKeyRecord[]> {
    return tx("readonly", (s) => s.getAll() as IDBRequest<DeviceKeyRecord[]>);
  }
  get(publicKey: string): Promise<DeviceKeyRecord | undefined> {
    return tx("readonly", (s) => s.get(publicKey) as IDBRequest<DeviceKeyRecord | undefined>);
  }
  async put(record: DeviceKeyRecord): Promise<void> {
    await tx("readwrite", (s) => s.put(record));
  }
  async remove(publicKey: string): Promise<void> {
    await tx("readwrite", (s) => s.delete(publicKey));
  }
}
