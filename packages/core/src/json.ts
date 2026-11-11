import { fail } from "./errors.js";

/**
 * Strict raw-boundary JSON parser.
 *
 * JSON.parse silently keeps the last of duplicate keys, accepts lone surrogates
 * and lossy numbers. At a trust boundary those are ambiguity, so this parser:
 * - rejects duplicate object keys (DUPLICATE_KEY);
 * - rejects unpaired UTF-16 surrogates in strings (MALFORMED_JSON);
 * - rejects fractional/exponent numbers and integers outside the safe range
 *   (amounts must be decimal strings);
 * - enforces byte, depth, string, array and key-count budgets (LIMIT_EXCEEDED);
 * - rejects a leading byte-order mark and trailing content.
 */
export interface JsonLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
}

export const DEFAULT_JSON_LIMITS: JsonLimits = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxStringLength: 16 * 1024,
  maxArrayLength: 4096,
  maxObjectKeys: 256,
});

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const decoder = new TextDecoder("utf-8", { fatal: true });

export function parseStrictJson(
  input: string | Uint8Array,
  limits: JsonLimits = DEFAULT_JSON_LIMITS,
): JsonValue {
  let text: string;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > limits.maxBytes) {
      fail("LIMIT_EXCEEDED", "JSON body exceeds byte limit", { maxBytes: limits.maxBytes });
    }
    text = input;
  } else {
    if (input.byteLength > limits.maxBytes) {
      fail("LIMIT_EXCEEDED", "JSON body exceeds byte limit", { maxBytes: limits.maxBytes });
    }
    try {
      text = decoder.decode(input);
    } catch {
      fail("MALFORMED_JSON", "JSON body is not valid UTF-8");
    }
  }
  if (text.charCodeAt(0) === 0xfeff) fail("MALFORMED_JSON", "byte-order mark is not allowed");
  const p = new Parser(text, limits);
  p.ws();
  const value = p.value(0);
  p.ws();
  if (p.i !== text.length) p.err("trailing content after JSON value");
  return value;
}

class Parser {
  i = 0;
  constructor(
    private readonly s: string,
    private readonly limits: JsonLimits,
  ) {}

  err(message: string): never {
    fail("MALFORMED_JSON", message, { offset: this.i });
  }

  ws(): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  value(depth: number): JsonValue {
    if (depth > this.limits.maxDepth)
      fail("LIMIT_EXCEEDED", "JSON nesting too deep", { maxDepth: this.limits.maxDepth });
    const c = this.s[this.i];
    switch (c) {
      case "{":
        return this.object(depth);
      case "[":
        return this.array(depth);
      case '"':
        return this.string();
      case "t":
        return this.literal("true", true);
      case "f":
        return this.literal("false", false);
      case "n":
        return this.literal("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.number();
        return this.err("unexpected character");
    }
  }

  literal<T extends JsonValue>(word: string, v: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return v;
    }
    return this.err("invalid literal");
  }

  number(): number {
    const m = /^-?(0|[1-9][0-9]*)([.eE])?/.exec(this.s.slice(this.i, this.i + 32));
    if (!m) return this.err("invalid number");
    if (m[2] !== undefined) {
      fail("VALIDATION_FAILED", "fractional or exponent numbers are not accepted; use decimal strings", {
        offset: this.i,
      });
    }
    const raw = m[0];
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      fail("VALIDATION_FAILED", "integer outside safe range; use a decimal string", { offset: this.i });
    }
    if (raw === "-0") fail("VALIDATION_FAILED", "negative zero is not accepted", { offset: this.i });
    this.i += raw.length;
    return n;
  }

  string(): string {
    const s = this.s;
    this.i++; // opening quote
    let out = "";
    let start = this.i;
    for (;;) {
      if (this.i >= s.length) this.err("unterminated string");
      const c = s.charCodeAt(this.i);
      if (c === 0x22) {
        out += s.slice(start, this.i);
        this.i++;
        break;
      }
      if (c < 0x20) this.err("control character in string");
      if (c === 0x5c) {
        out += s.slice(start, this.i);
        this.i++;
        const e = s[this.i];
        this.i++;
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = s.slice(this.i, this.i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.err("invalid unicode escape");
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.i += 4;
            break;
          }
          default:
            this.err("invalid escape");
        }
        start = this.i;
        continue;
      }
      this.i++;
    }
    if (!isWellFormed(out)) this.err("unpaired surrogate in string");
    if (out.length > this.limits.maxStringLength) {
      fail("LIMIT_EXCEEDED", "JSON string too long", { maxStringLength: this.limits.maxStringLength });
    }
    return out;
  }

  array(depth: number): JsonValue[] {
    this.i++;
    const out: JsonValue[] = [];
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth + 1));
      if (out.length > this.limits.maxArrayLength) {
        fail("LIMIT_EXCEEDED", "JSON array too long", { maxArrayLength: this.limits.maxArrayLength });
      }
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return out;
      }
      this.err("expected , or ]");
    }
  }

  object(depth: number): { [key: string]: JsonValue } {
    this.i++;
    // Null-prototype object so "__proto__" is an ordinary key, never a prototype write.
    const out: { [key: string]: JsonValue } = Object.create(null);
    const seen = new Set<string>();
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.err("expected object key");
      const keyOffset = this.i;
      const key = this.string();
      if (seen.has(key))
        fail("DUPLICATE_KEY", "duplicate JSON object key", { key: key.slice(0, 64), offset: keyOffset });
      seen.add(key);
      if (seen.size > this.limits.maxObjectKeys) {
        fail("LIMIT_EXCEEDED", "JSON object has too many keys", { maxObjectKeys: this.limits.maxObjectKeys });
      }
      this.ws();
      if (this.s[this.i] !== ":") this.err("expected :");
      this.i++;
      this.ws();
      out[key] = this.value(depth + 1);
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        return out;
      }
      this.err("expected , or }");
    }
  }
}

/** True when the string contains no unpaired UTF-16 surrogate. */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}
