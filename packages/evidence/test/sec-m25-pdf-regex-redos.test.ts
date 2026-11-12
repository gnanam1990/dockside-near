/** Security regression: PDF text extraction is linear and bounded by the slot parse-time limit. */
import { performance } from "node:perf_hooks";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classify, type ResourceLimits } from "../src/sniff.js";

const lim: ResourceLimits = {
  maxPages: 10,
  maxPixels: 1_000_000,
  maxDecompressedBytes: 1_048_576,
  maxDecompressionRatioPermille: 100_000_000,
  maxParseTimeMs: 100,
};

function pdf(dict: string, body: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n${dict}\nstream\n`),
    body,
    Buffer.from("\nendstream\nendobj\n2 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n"),
  ]);
}

const outcome = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

/** The extraction rule as originally written, used as the behavioural reference. */
function reference(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*T[jJ]/g)) {
    out.push(
      (m[1] as string).replace(/\\([nrtbf()\\])/g, (_x, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c === "b" || c === "f" ? "" : c,
      ),
    );
  }
  return out;
}

const extract = (content: string): string => {
  const r = classify(pdf("<< /Length 0 >>", Buffer.from(content, "latin1")), {
    ...lim,
    maxParseTimeMs: 60_000,
  });
  return new TextDecoder().decode(r.derived.TEXT_EXTRACT);
};

describe("PDF string extraction cannot hold the request thread", () => {
  const unclosed = "(".repeat(64_000);

  it("scans 64000 unclosed '(' in a raw stream within about the parse deadline", () => {
    const t0 = performance.now();
    const code = outcome(() => classify(pdf("<< /Length 64000 >>", Buffer.from(unclosed)), lim));
    const ms = performance.now() - t0;
    expect(["ok", "LIMIT_EXCEEDED"]).toContain(code);
    expect(ms).toBeLessThan(2 * lim.maxParseTimeMs);
  });

  it("scans 64000 unclosed '(' in a Flate stream within about the parse deadline", () => {
    const body = deflateSync(Buffer.from(unclosed));
    const t0 = performance.now();
    const code = outcome(() => classify(pdf("<< /Filter /FlateDecode >>", body), lim));
    const ms = performance.now() - t0;
    expect(["ok", "LIMIT_EXCEEDED"]).toContain(code);
    expect(ms).toBeLessThan(2 * lim.maxParseTimeMs);
  });

  it("extracts the same strings as the original rule", () => {
    const cases = [
      "BT (Invoice INV-1) Tj ET",
      "(a) Tj (b)TJ (c) Td (d)\n\t TJ",
      "(a (b) Tj",
      "((x) Tj",
      "(esc \\) still) Tj",
      "(\\n\\r\\t\\b\\f\\(\\)\\\\\\q) Tj",
      "(bad \\\n escape) Tj (ok) Tj",
      "(bad \\\r escape) Tj (ok) Tj",
      "\\(x) Tj",
      "(a) T (b) Tj",
      "(unterminated \\",
      "() Tj",
      "(a)Tj(b)Tj",
      "((((",
      "(x\\\\) Tj",
      "(x\\\\\\) y) Tj",
      "( )  Tj (\u0085) \u0085Tj",
    ];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ["(", ")", "\\", "T", "j", "J", " ", "\n", "\r", "a", "n", " "];
    for (let k = 0; k < 2000; k++) {
      let s = "";
      const len = 1 + rnd(40);
      for (let i = 0; i < len; i++) s += alphabet[rnd(alphabet.length)];
      cases.push(s);
    }
    for (const c of cases) {
      expect(extract(c), JSON.stringify(c)).toBe(reference(c).join("\n").normalize("NFC"));
    }
  });
});
