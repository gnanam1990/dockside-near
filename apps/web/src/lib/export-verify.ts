import { base58Decode } from "./base58";
import { type CanonicalValue, canonicalDigest, sha256, toHex } from "./canonical";

/**
 * In-browser check of a signed audit export (ADR-0018), mirroring services/api/src/verify-export.ts:
 * the export's own checksum, the statement's binding to it, its DCE-1 digest and the Ed25519
 * signature under `dockside/audit-export`, and whether the key is in the list this server publishes.
 * Independent verification uses the offline `verify-export` command with the operator's key list.
 */
export interface ExportKeyEntry {
  readonly keyId: string;
  readonly publicKey: string;
  readonly origin: string;
  readonly network: string;
  readonly status: "ACTIVE" | "RETIRED" | "REVOKED";
  readonly enrolledAt: number;
  readonly retiredAt: number | null;
  readonly revokedAt: number | null;
}

export interface BrowserExportCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly label: string;
}

export function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  throw new Error(`unsupported value ${typeof v}`);
}

function copy(b: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export async function verifySignedExportInBrowser(
  bundle: unknown,
  keys: readonly ExportKeyEntry[],
): Promise<{ ok: boolean; checks: BrowserExportCheck[] }> {
  const checks: BrowserExportCheck[] = [];
  const add = (id: string, ok: boolean, label: string) => checks.push({ id, ok, label });
  if (!isObj(bundle) || !isObj(bundle["export"]) || !isObj(bundle["statement"])) {
    add("shape", false, "Not a signed export bundle");
    return { ok: false, checks };
  }
  const ex = bundle["export"];
  const st = bundle["statement"];
  const { checksum, ...rest } = ex;
  const recomputed = toHex(await sha256(new TextEncoder().encode(stableStringify(rest))));
  add("checksum", recomputed === checksum, "Export checksum recomputed in this browser");
  const by = isObj(ex["exportedBy"]) ? ex["exportedBy"] : {};
  const sb = isObj(st["exportedBy"]) ? st["exportedBy"] : {};
  const integrity = isObj(ex["integrity"]) ? ex["integrity"] : {};
  const binds =
    st["exportChecksum"] === checksum &&
    st["tradeId"] === ex["tradeId"] &&
    st["generatedAt"] === ex["generatedAt"] &&
    st["destinations"] === ex["destinations"] &&
    st["exportSchema"] === ex["schema"] &&
    (st["auditHeadHash"] ?? null) === (integrity["auditHeadHash"] ?? null) &&
    ["principalId", "keyVersionId", "organizationId"].every((k) => sb[k] === by[k]);
  add("binds", binds, "Signed statement binds this export's checksum, trade, exporter and audit head");
  let digestOk = false;
  let sigOk = false;
  try {
    const digest = await canonicalDigest("dockside/audit-export", 1, st as CanonicalValue);
    digestOk = toHex(digest) === bundle["statementDigest"];
    const pk = String(st["publicKey"] ?? "");
    const sig = String(bundle["signature"] ?? "");
    if (pk.startsWith("ed25519:") && sig.startsWith("ed25519:")) {
      const key = await crypto.subtle.importKey(
        "raw",
        copy(base58Decode(pk.slice(8))),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      sigOk = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        copy(base58Decode(sig.slice(8))),
        copy(digest),
      );
    }
  } catch {
    sigOk = false;
  }
  add("digest", digestOk, "Statement digest (DCE-1, dockside/audit-export) recomputed");
  add("signature", sigOk, "Ed25519 signature verifies with the key the statement names");
  const k = keys.find((x) => x.keyId === st["keyId"] && x.publicKey === st["publicKey"]);
  const signedAt = typeof st["signedAt"] === "number" ? st["signedAt"] : -1;
  add(
    "key",
    k !== undefined &&
      k.status !== "REVOKED" &&
      k.origin === st["origin"] &&
      signedAt >= k.enrolledAt &&
      (k.retiredAt === null || signedAt < k.retiredAt),
    "Signing key is an enrolled, unrevoked export key of this server and was valid when it signed",
  );
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * In-browser check of a signed payment receipt (M54), mirroring services/api/src/receipt.ts: the
 * statement's DCE-1 digest and Ed25519 signature under `dockside/payment-receipt`, the key against
 * the list this server publishes, and that the PDF offered for download is the one the server
 * hashed and carries exactly this signed statement as its attachment. The payment itself is
 * checked on NEAR by the receipt page (statement.verifyUrl); the offline check of the saved file
 * is `verify-receipt` with the operator's key list.
 */
export async function verifySignedReceiptInBrowser(
  bundle: unknown,
  keys: readonly ExportKeyEntry[],
): Promise<{ ok: boolean; checks: BrowserExportCheck[]; pdf: Uint8Array | null }> {
  const checks: BrowserExportCheck[] = [];
  const add = (id: string, ok: boolean, label: string) => checks.push({ id, ok, label });
  if (!isObj(bundle) || !isObj(bundle["statement"]) || !isObj(bundle["pdf"])) {
    add("shape", false, "Not a signed payment receipt");
    return { ok: false, checks, pdf: null };
  }
  const st = bundle["statement"];
  let digestOk = false;
  let sigOk = false;
  try {
    const digest = await canonicalDigest("dockside/payment-receipt", 1, st as CanonicalValue);
    digestOk = toHex(digest) === bundle["statementDigest"];
    const pk = String(st["publicKey"] ?? "");
    const sig = String(bundle["signature"] ?? "");
    if (pk.startsWith("ed25519:") && sig.startsWith("ed25519:")) {
      const key = await crypto.subtle.importKey(
        "raw",
        copy(base58Decode(pk.slice(8))),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      sigOk = await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        copy(base58Decode(sig.slice(8))),
        copy(digest),
      );
    }
  } catch {
    sigOk = false;
  }
  add("digest", digestOk, "Statement digest (DCE-1, dockside/payment-receipt) recomputed");
  add("signature", sigOk, "Ed25519 signature verifies with the key the statement names");
  const k = keys.find((x) => x.keyId === st["keyId"] && x.publicKey === st["publicKey"]);
  const signedAt = typeof st["signedAt"] === "number" ? st["signedAt"] : -1;
  add(
    "key",
    k !== undefined &&
      k.status !== "REVOKED" &&
      k.origin === st["origin"] &&
      signedAt >= k.enrolledAt &&
      (k.retiredAt === null || signedAt < k.retiredAt),
    "Signing key is an enrolled, unrevoked export key of this server and was valid when it signed",
  );
  let pdf: Uint8Array | null = null;
  let pdfOk = false;
  try {
    const p = bundle["pdf"];
    const bin = atob(String(p["base64"] ?? ""));
    pdf = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const signed = JSON.stringify({
      schema: bundle["schema"],
      statement: st,
      statementDigest: bundle["statementDigest"],
      signature: bundle["signature"],
    });
    pdfOk =
      bin.startsWith("%PDF-1.4\n") &&
      toHex(await sha256(pdf)) === p["sha256"] &&
      bin.includes(`/Length ${signed.length} >>\nstream\n${signed}\nendstream`);
  } catch {
    pdfOk = false;
  }
  add("pdf", pdfOk, "The PDF matches its digest and carries exactly this signed statement");
  return { ok: checks.every((c) => c.ok), checks, pdf: pdfOk ? pdf : null };
}
