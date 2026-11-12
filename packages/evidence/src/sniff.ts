import { performance } from "node:perf_hooks";
import { inflateSync } from "node:zlib";
import { type DocksideError, fail } from "@dockside/core";
import { type ContentClass, PARSER_PROFILE, SUPPORTED_MIME, type SupportedMime } from "./policy.js";

/**
 * `dockside-sniff@1`: classify an upload from its bytes (never from a declared label) and
 * measure the parser-resource facts an EvidencePolicy limits. Decompression is bounded by
 * the slot limits before any buffer is allocated, active PDF content and polyglot trailers
 * are refused, and nothing is executed or rendered.
 */
export interface ResourceLimits {
  readonly maxPages: number;
  readonly maxPixels: number;
  readonly maxDecompressedBytes: number;
  readonly maxDecompressionRatioPermille: number;
  readonly maxParseTimeMs: number;
}

export interface Resources {
  readonly pages: number;
  readonly pixels: number;
  readonly decompressedBytes: number;
  readonly decompressionRatioPermille: number;
  readonly parseTimeMs: number;
  readonly parserProfile: string;
}

export interface Classified {
  readonly mime: SupportedMime;
  readonly contentClass: ContentClass;
  readonly resources: Resources;
  /** Text extracted for TEXT_EXTRACT (documents) or canonical metadata JSON (images). */
  readonly derived: { readonly TEXT_EXTRACT?: Uint8Array; readonly IMAGE_METADATA?: Uint8Array };
}

const latin1 = new TextDecoder("latin1");
const utf8 = new TextEncoder();

function limit(message: string): never {
  return fail("LIMIT_EXCEEDED", message);
}

function boundedInflate(data: Uint8Array, maxOut: number): Uint8Array {
  try {
    return new Uint8Array(inflateSync(data, { maxOutputLength: Math.max(1, maxOut) }));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) limit("decompressed bytes over limit");
    return fail("UNSUPPORTED_CONTENT", "compressed data is corrupt");
  }
}

function startsWith(b: Uint8Array, sig: readonly number[]): boolean {
  return b.length >= sig.length && sig.every((x, i) => b[i] === x);
}

/* --------------------------------- PNG ---------------------------------- */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function sniffPng(b: Uint8Array, lim: ResourceLimits) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let ended = false;
  let first = true;
  while (off + 12 <= b.length) {
    const len = dv.getUint32(off);
    const type = latin1.decode(b.subarray(off + 4, off + 8));
    if (off + 12 + len > b.length) fail("UNSUPPORTED_CONTENT", "truncated PNG chunk");
    const body = b.subarray(off + 8, off + 8 + len);
    if (crc32(b.subarray(off + 4, off + 8 + len)) !== dv.getUint32(off + 8 + len))
      fail("UNSUPPORTED_CONTENT", "PNG chunk CRC mismatch");
    if (first && type !== "IHDR") fail("UNSUPPORTED_CONTENT", "PNG must start with IHDR");
    first = false;
    if (type === "IHDR") {
      if (len !== 13) fail("UNSUPPORTED_CONTENT", "IHDR malformed");
      const h = new DataView(body.buffer, body.byteOffset, 13);
      width = h.getUint32(0);
      height = h.getUint32(4);
      bitDepth = body[8] as number;
      colorType = body[9] as number;
      if (body[12] !== 0) fail("UNSUPPORTED_CONTENT", "interlaced PNG is not supported by dockside-sniff@1");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") {
      ended = true;
      off += 12 + len;
      break;
    } else if (type !== "PLTE" && (type.charCodeAt(0) & 0x20) === 0) {
      fail("UNSUPPORTED_CONTENT", `unknown critical PNG chunk ${type}`);
    }
    off += 12 + len;
  }
  if (!ended) fail("UNSUPPORTED_CONTENT", "PNG has no IEND");
  if (off !== b.length) fail("MALICIOUS_CONTENT", "data after PNG IEND (polyglot)");
  const channels = PNG_CHANNELS[colorType];
  if (channels === undefined || width === 0 || height === 0 || ![1, 2, 4, 8, 16].includes(bitDepth))
    fail("UNSUPPORTED_CONTENT", "PNG header invalid");
  const pixels = width * height;
  if (pixels > lim.maxPixels) limit("pixel count over limit");
  const expected = height * (1 + Math.ceil((width * channels * bitDepth) / 8));
  if (expected > lim.maxDecompressedBytes) limit("decompressed bytes over limit");
  const total = idat.reduce((a, c) => a + c.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = boundedInflate(joined, expected);
  if (raw.length !== expected) fail("UNSUPPORTED_CONTENT", "PNG image data size mismatch");
  const meta = { bitDepth, colorType, height, mime: "image/png", width };
  return { mime: "image/png" as const, pages: 0, pixels, decompressed: raw.length, meta };
}

/* --------------------------------- JPEG --------------------------------- */

function sniffJpeg(b: Uint8Array, lim: ResourceLimits) {
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) fail("UNSUPPORTED_CONTENT", "JPEG has no EOI");
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) fail("UNSUPPORTED_CONTENT", "JPEG marker expected");
    const m = b[off + 1] as number;
    const len = ((b[off + 2] as number) << 8) | (b[off + 3] as number);
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      const height = ((b[off + 5] as number) << 8) | (b[off + 6] as number);
      const width = ((b[off + 7] as number) << 8) | (b[off + 8] as number);
      const comps = b[off + 9] as number;
      if (width === 0 || height === 0 || comps === 0) fail("UNSUPPORTED_CONTENT", "JPEG frame invalid");
      const pixels = width * height;
      if (pixels > lim.maxPixels) limit("pixel count over limit");
      // Decoded size estimate: every component sample at 8 bits.
      const decompressed = pixels * comps;
      const meta = { components: comps, height, mime: "image/jpeg", width };
      return { mime: "image/jpeg" as const, pages: 0, pixels, decompressed, meta };
    }
    off += 2 + len;
  }
  return fail("UNSUPPORTED_CONTENT", "JPEG has no frame header");
}

/* ---------------------------------- PDF --------------------------------- */

/** Names that make a PDF interactive or able to act on the viewer's machine. */
const ACTIVE_PDF = [
  "JavaScript",
  "JS",
  "Launch",
  "OpenAction",
  "AA",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
  "SubmitForm",
  "ImportData",
  "GoToR",
  "GoToE",
  "XFA",
];

function decodeNames(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\/([^\s/<>[\]()%{}]+)/g)) {
    const raw = m[1] as string;
    out.push(
      raw.replace(/#([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
    );
  }
  return out;
}

const LINE_TERMINATOR = new Set(["\n", "\r", " ", " "]);
const SHOW_TEXT = /\s*T[jJ]/y;

/** Fails LIMIT_EXCEEDED as soon as the slot's parse deadline has passed, not after parsing. */
function checkDeadline(deadline: number): void {
  if (performance.now() > deadline) limit("parse time over limit");
}

/**
 * Strings shown by `(...) Tj` / `(...) TJ`, with the same matches as the rule
 * /\(((?:\\.|[^\\)])*)\)\s*T[jJ]/g but in one forward pass: every '(' still open when the
 * scan reaches an unescaped ')' (or a backslash before a line end) shares that outcome, so
 * no position is rescanned.
 */
function pdfStrings(content: string, deadline: number): string[] {
  const out: string[] = [];
  const n = content.length;
  let open = -1; // earliest '(' whose candidate string is still being scanned
  let i = 0;
  while (i < n) {
    if ((i & 0xffff) === 0) checkDeadline(deadline);
    const c = content[i] as string;
    if (open < 0) {
      if (c === "(") open = i;
      i++;
      continue;
    }
    if (c === "\\") {
      // `\\.`: an escape pairs with any next character except a line end; otherwise no match.
      if (i + 1 >= n || LINE_TERMINATOR.has(content[i + 1] as string)) {
        open = -1;
        i++;
        continue;
      }
      i += 2;
      continue;
    }
    if (c !== ")") {
      i++;
      continue;
    }
    SHOW_TEXT.lastIndex = i + 1;
    if (SHOW_TEXT.test(content)) {
      out.push(
        content
          .slice(open + 1, i)
          .replace(/\\([nrtbf()\\])/g, (_x, e: string) =>
            e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "b" || e === "f" ? "" : e,
          ),
      );
      i = SHOW_TEXT.lastIndex;
    } else {
      i++;
    }
    open = -1;
  }
  return out;
}

function sniffPdf(b: Uint8Array, lim: ResourceLimits, deadline: number) {
  const s = latin1.decode(b);
  if (!/%%EOF\s*$/.test(s)) fail("UNSUPPORTED_CONTENT", "PDF has no trailer");
  if (s.lastIndexOf("%%EOF") < s.length - 1024)
    fail("MALICIOUS_CONTENT", "data after PDF trailer (polyglot)");
  let outside = "";
  let decoded = 0;
  let rawStreams = 0;
  const texts: string[] = [];
  const re = /stream\r?\n/g;
  let last = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) fail("UNSUPPORTED_CONTENT", "unterminated PDF stream");
    // The whole region since the previous stream: a nested dictionary (e.g. /DecodeParms << >>) must not
    // hide this stream's /Filter. A /Filter in an earlier stream-less object fails closed.
    const dict = s.slice(last, m.index);
    outside += s.slice(last, m.index);
    const body = b.subarray(start, end);
    rawStreams += body.length;
    let content: Uint8Array = body;
    if (/\/FlateDecode/.test(dict)) {
      content = boundedInflate(body, lim.maxDecompressedBytes - decoded);
    } else if (/\/Filter/.test(dict)) {
      fail("UNSUPPORTED_CONTENT", "PDF stream filter not supported by dockside-sniff@1");
    }
    decoded += content.length;
    if (decoded > lim.maxDecompressedBytes) limit("decompressed bytes over limit");
    const text = latin1.decode(content);
    outside += decodeNames(text)
      .map((n) => `/${n} `)
      .join("");
    checkDeadline(deadline);
    texts.push(...pdfStrings(text, deadline));
    checkDeadline(deadline);
    last = end + "endstream".length;
    re.lastIndex = last;
  }
  outside += s.slice(last);
  const names = decodeNames(outside);
  if (names.includes("Encrypt")) fail("UNSUPPORTED_CONTENT", "encrypted PDF");
  const active = names.find((n) => ACTIVE_PDF.includes(n));
  if (active !== undefined) fail("MALICIOUS_CONTENT", `active PDF content (/${active})`);
  const pages = [...outside.matchAll(/\/Type\s*\/Page(?![A-Za-z])/g)].length;
  if (pages === 0) fail("UNSUPPORTED_CONTENT", "PDF has no pages");
  if (pages > lim.maxPages) limit("page count over limit");
  const total = b.length - rawStreams + decoded;
  return { mime: "application/pdf" as const, pages, pixels: 0, decompressed: total, text: texts.join("\n") };
}

/* ---------------------------------- text -------------------------------- */

function sniffText(b: Uint8Array) {
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return fail("UNSUPPORTED_CONTENT", "content is not a supported type");
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
      fail("UNSUPPORTED_CONTENT", "control characters in text content");
  }
  return { mime: "text/plain" as const, pages: 1, pixels: 0, decompressed: b.length, text: s };
}

/** Classify bytes and measure resources; throws LIMIT_EXCEEDED / MALICIOUS_CONTENT / UNSUPPORTED_CONTENT. */
export function classify(bytes: Uint8Array, lim: ResourceLimits): Classified {
  if (bytes.length === 0) fail("UNSUPPORTED_CONTENT", "empty content");
  const t0 = performance.now();
  let r:
    | ReturnType<typeof sniffPng>
    | ReturnType<typeof sniffJpeg>
    | ReturnType<typeof sniffPdf>
    | ReturnType<typeof sniffText>;
  if (startsWith(bytes, PNG_SIG)) r = sniffPng(bytes, lim);
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) r = sniffJpeg(bytes, lim);
  else if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    r = sniffPdf(bytes, lim, t0 + lim.maxParseTimeMs);
  else if (
    startsWith(bytes, [0x4d, 0x5a]) ||
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
  ) {
    return fail("UNSUPPORTED_CONTENT", "executable or archive content");
  } else r = sniffText(bytes);
  const parseTimeMs = Math.ceil(performance.now() - t0);
  if (r.decompressed > lim.maxDecompressedBytes) limit("decompressed bytes over limit");
  const ratio = Math.floor((r.decompressed * 1000) / bytes.length);
  if (ratio > lim.maxDecompressionRatioPermille) limit("decompression ratio over limit");
  if (parseTimeMs > lim.maxParseTimeMs) limit("parse time over limit");
  const derived =
    "meta" in r
      ? { IMAGE_METADATA: utf8.encode(JSON.stringify(r.meta)) }
      : { TEXT_EXTRACT: utf8.encode(r.text.normalize("NFC")) };
  return {
    mime: r.mime,
    contentClass: SUPPORTED_MIME[r.mime],
    resources: {
      pages: r.pages,
      pixels: r.pixels,
      decompressedBytes: r.decompressed,
      decompressionRatioPermille: ratio,
      parseTimeMs,
      parserProfile: PARSER_PROFILE,
    },
    derived,
  };
}

/** Rejections that are about the bytes themselves; these are quarantined for review. */
export function isContentRejection(e: DocksideError): boolean {
  return e.code === "LIMIT_EXCEEDED" || e.code === "MALICIOUS_CONTENT" || e.code === "UNSUPPORTED_CONTENT";
}
