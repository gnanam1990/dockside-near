/**
 * M54: the QR code encoder of the payment receipt (site/proof/lib/qr.mjs), shared by the receipt
 * page and the signed PDF. Every symbol produced here is rasterised and read back by an
 * independent decoder (jsQR), so a wrong table, mask or interleaving shows up as a decode failure,
 * not as a symbol that only looks right.
 */
import jsQRModule from "jsqr";
import { describe, expect, it } from "vitest";
import { encodeQr, qrPathData } from "../../../site/proof/lib/qr.mjs";

// jsqr is CommonJS with an ES default export: under NodeNext its default import types as the module.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ??
  jsQRModule) as typeof jsQRModule.default;

function decode(qr: { size: number; modules: boolean[][] }, scale = 4, quiet = 4): string | null {
  const n = (qr.size + 2 * quiet) * scale;
  const rgba = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y]?.[x]) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const p = (((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx) * 4;
          rgba[p] = 0;
          rgba[p + 1] = 0;
          rgba[p + 2] = 0;
        }
    }
  return jsQR(rgba, n, n, { inversionAttempts: "dontInvert" })?.data ?? null;
}

const RECEIPT_URL =
  "https://dockside.example/receipt/trd_197c633d724eeb2cddc64d6dabf55976?network=testnet&tx=9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn";

describe("M54 QR encoder", () => {
  it("encodes a receipt link that an independent decoder reads back exactly", () => {
    const qr = encodeQr(RECEIPT_URL);
    expect(qr.ecc).toBe("M");
    expect(qr.size).toBe(qr.version * 4 + 17);
    expect(qr.modules).toHaveLength(qr.size);
    expect(decode(qr)).toBe(RECEIPT_URL);
  });

  it("reads back at every error-correction level and across versions 1 to 36", () => {
    const seen = new Set<number>();
    for (const ecc of ["L", "M", "Q", "H"] as const)
      for (const len of [
        1, 7, 14, 17, 26, 32, 42, 53, 62, 78, 84, 106, 122, 154, 180, 213, 251, 311, 395, 520, 1000,
      ]) {
        const text = Array.from(
          { length: len },
          (_, i) => "0123456789abcdefXYZ/:?&=_-."[(i * 7 + len) % 27],
        ).join("");
        const qr = encodeQr(text, { ecc });
        seen.add(qr.version);
        expect(decode(qr), `${ecc} length ${len} version ${qr.version}`).toBe(text);
      }
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(36);
  });

  it("encodes UTF-8 bytes", () => {
    const text = "Dockside — reçu de paiement ✓";
    expect(decode(encodeQr(text))).toBe(text);
  });

  it("is deterministic and picks the smallest version that fits", () => {
    const a = encodeQr(RECEIPT_URL);
    const b = encodeQr(RECEIPT_URL);
    expect(a).toEqual(b);
    expect(encodeQr("x").version).toBe(1);
    // 14 bytes is the byte-mode capacity of version 1 at level M; one more needs version 2.
    expect(encodeQr("a".repeat(14)).version).toBe(1);
    expect(encodeQr("a".repeat(15)).version).toBe(2);
  });

  it("byte-mode capacity equals the ISO/IEC 18004 table at every level", () => {
    // Version: [L, M, Q, H] byte capacity.
    const table: Record<number, [number, number, number, number]> = {
      1: [17, 14, 11, 7],
      2: [32, 26, 20, 14],
      5: [106, 84, 60, 44],
      7: [154, 122, 86, 64],
      10: [271, 213, 151, 119],
      20: [858, 666, 482, 382],
      27: [1465, 1125, 805, 625],
      40: [2953, 2331, 1663, 1273],
    };
    for (const [v, caps] of Object.entries(table))
      (["L", "M", "Q", "H"] as const).forEach((ecc, i) => {
        const cap = caps[i] as number;
        expect(encodeQr("a".repeat(cap), { ecc }).version, `${ecc} ${cap}`).toBe(Number(v));
        if (Number(v) < 40) expect(encodeQr("a".repeat(cap + 1), { ecc }).version).toBe(Number(v) + 1);
        else expect(() => encodeQr("a".repeat(cap + 1), { ecc })).toThrow(/too long/);
      });
  });

  it("refuses text longer than version 40 holds", () => {
    expect(() => encodeQr("a".repeat(2332), { ecc: "M" })).toThrow(/too long/);
  });

  it("describes the dark modules as one SVG path, one unit square per module", () => {
    const qr = encodeQr("dockside");
    const d = qrPathData(qr);
    const squares = d.match(/M\d+ \d+h1v1h-1z/g) ?? [];
    const dark = qr.modules.flat().filter(Boolean).length;
    expect(squares).toHaveLength(dark);
    expect(squares.join("")).toBe(d);
  });
});
