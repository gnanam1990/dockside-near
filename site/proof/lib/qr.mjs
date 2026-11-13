// QR code encoder (ISO/IEC 18004, model 2, byte mode), for the payment receipt link printed on
// the receipt page and in the signed PDF. Plain ES module, no dependency: the page loads it from
// its own origin under a content security policy that allows no third-party script, and the API
// imports the same file to draw the code into the PDF.
//
// Output: { version, ecc, size, mask, modules } where modules[y][x] is true for a dark module.
// The encoder is deterministic: the same text and level always give the same symbol.

const ECC = {
  // ordinal, format bits
  L: [0, 1],
  M: [1, 0],
  Q: [2, 3],
  H: [3, 2],
};

// Error-correction codewords per block and number of blocks, by level and version (index 0 unused).
const ECC_PER_BLOCK = [
  [
    -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  [
    -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30,
    28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  [
    -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
];
const BLOCKS = [
  [
    -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16,
    17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  [
    -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28,
    29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  [
    -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35,
    38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  [
    -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42,
    45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
];

/** Modules available for data and error correction in a symbol of this version. */
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver, e) =>
  Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * BLOCKS[e][ver];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] ^= gfMul(divisor[i], factor);
  }
  return out;
}

function interleave(data, ver, e) {
  const blocks = BLOCKS[e][ver];
  const eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    all.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < all[0].length; i++) {
    for (let j = 0; j < all.length; j++) {
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(all[j][i]);
    }
  }
  return out;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class QrSymbol {
  constructor(ver, eccName) {
    this.ver = ver;
    this.eccName = eccName;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  setFixed(x, y, dark) {
    this.modules[y][x] = dark;
    this.fixed[y][x] = true;
  }

  drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.setFixed(6, i, i % 2 === 0);
      this.setFixed(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [s - 4, 3],
      [3, s - 4],
    ]) {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < s && y >= 0 && y < s) this.setFixed(x, y, d !== 2 && d !== 4);
        }
    }
    const pos = alignmentPositions(this.ver);
    const n = pos.length;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.setFixed(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    this.drawFormatBits(0);
    if (this.ver >= 7) {
      let rem = this.ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFixed(a, b, bit(bits, i));
        this.setFixed(b, a, bit(bits, i));
      }
    }
  }

  drawFormatBits(mask) {
    const s = this.size;
    const data = (ECC[this.eccName][1] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(bits, i));
    this.setFixed(8, 7, bit(bits, 6));
    this.setFixed(8, 8, bit(bits, 7));
    this.setFixed(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.setFixed(s - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.setFixed(8, s - 15 + i, bit(bits, i));
    this.setFixed(8, s - 8, true);
  }

  drawCodewords(codewords) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < s; v++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? s - 1 - v : v;
          if (!this.fixed[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++)
        if (!this.fixed[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
  }

  penalty() {
    const s = this.size;
    const m = this.modules;
    let score = 0;
    const line = (get) => {
      let run = 1;
      for (let i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with four light modules on one side.
      for (let i = 0; i + 11 <= s; i++) {
        const w = Array.from({ length: 11 }, (_, k) => get(i + k));
        const a = [true, false, true, true, true, false, true, false, false, false, false];
        if (a.every((v, k) => v === w[k]) || a.every((v, k) => v === w[10 - k])) score += 40;
      }
    };
    for (let y = 0; y < s; y++) line((x) => m[y][x]);
    for (let x = 0; x < s; x++) line((y) => m[y][x]);
    for (let y = 0; y + 1 < s; y++)
      for (let x = 0; x + 1 < s; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
      }
    const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
    const total = s * s;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/**
 * @param {string} text
 * @param {{ecc?: "L" | "M" | "Q" | "H"}} [options]
 */
export function encodeQr(text, { ecc = "M" } = {}) {
  const level = ECC[ecc];
  if (!level) throw new Error(`unknown error-correction level ${ecc}`);
  const e = level[0];
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver, e) * 8) break;
  }
  if (ver > 40) throw new Error("text too long for a QR code");
  const capacity = dataCodewords(ver, e) * 8;
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const codewords = interleave(data, ver, e);
  const sym = new QrSymbol(ver, ecc);
  sym.drawFunctionPatterns();
  sym.drawCodewords(codewords);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    sym.applyMask(mask);
    sym.drawFormatBits(mask);
    const p = sym.penalty();
    if (p < bestScore) {
      best = mask;
      bestScore = p;
    }
    sym.applyMask(mask);
  }
  sym.applyMask(best);
  sym.drawFormatBits(best);
  return { version: ver, ecc, size: sym.size, mask: best, modules: sym.modules.map((r) => [...r]) };
}

/** SVG path data for the dark modules, one unit square per module (viewBox 0 0 size size). */
export function qrPathData(qr) {
  let d = "";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.modules[y][x]) d += `M${x} ${y}h1v1h-1z`;
  return d;
}
