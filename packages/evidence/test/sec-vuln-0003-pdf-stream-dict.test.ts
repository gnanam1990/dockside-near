/** Security regression: a stream's /Filter must be honoured even when a nested dictionary follows it. */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classify, type ResourceLimits } from "../src/sniff.js";

const lim: ResourceLimits = {
  maxPages: 10,
  maxPixels: 1_000_000,
  maxDecompressedBytes: 1_000_000,
  maxDecompressionRatioPermille: 10_000_000,
  maxParseTimeMs: 5000,
};

const hidden = deflateSync(
  Buffer.from("<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>"),
);
const benign = deflateSync(Buffer.from("BT /F1 12 Tf 72 712 Td (Invoice INV-1) Tj ET"));

function pdf(dict: string, body: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n${dict}\nstream\n`),
    body,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 3 0 R >>\n%%EOF\n"),
  ]);
}

const codeOf = (f: () => unknown): string | undefined => {
  try {
    f();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe("PDF sniffer resolves the whole stream dictionary", () => {
  const len = hidden.length;
  it.each([
    ["plain /Filter", `<< /Type /ObjStm /Filter /FlateDecode /Length ${len} >>`],
    [
      "/Filter before nested /DecodeParms",
      `<< /Type /ObjStm /Filter /FlateDecode /DecodeParms << /Predictor 1 >> /Length ${len} >>`,
    ],
    [
      "/DecodeParms before /Filter",
      `<< /Type /ObjStm /DecodeParms << /Predictor 1 >> /Filter /FlateDecode /Length ${len} >>`,
    ],
    [
      "/Filter array with nested dict",
      `<< /Filter [/FlateDecode] /DecodeParms [<< /Predictor 1 >>] /Length ${len} >>`,
    ],
  ])("refuses hidden active content: %s", (_n, dict) => {
    expect(codeOf(() => classify(pdf(dict, hidden), lim))).toBe("MALICIOUS_CONTENT");
  });

  it("refuses an unsupported filter placed before a nested dictionary", () => {
    const dict = `<< /Filter /LZWDecode /DecodeParms << /EarlyChange 0 >> /Length ${len} >>`;
    expect(codeOf(() => classify(pdf(dict, hidden), lim))).toBe("UNSUPPORTED_CONTENT");
  });

  it("still accepts a benign compressed stream with nested /DecodeParms and extracts its text", () => {
    const dict = `<< /Filter /FlateDecode /DecodeParms << /Predictor 1 >> /Length ${benign.length} >>`;
    const r = classify(pdf(dict, benign), lim);
    expect(r.mime).toBe("application/pdf");
    expect(new TextDecoder().decode(r.derived.TEXT_EXTRACT)).toContain("Invoice INV-1");
  });
});
