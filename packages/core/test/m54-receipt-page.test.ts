/**
 * M54: the payment receipt page (site/proof/receipt.html) is a static page on the proof site, with
 * the same hardening as the proof page: the RPC endpoints of the manifest are the only other
 * origins it may reach, it loads nothing from a third party and writes chain data as text only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const csp = (html: string) =>
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";

describe("M54 receipt page", () => {
  const html = read("site/proof/receipt.html");

  it("has exactly the proof page's content security policy", () => {
    expect(csp(html)).not.toBe("");
    expect(csp(html)).toBe(csp(read("site/proof/index.html")));
  });

  it("loads nothing from a third party and has no inline script or handler", () => {
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(refs).toEqual(["./proof.css", "#receipt", "./index.html", "./receipt.mjs"]);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\son\w+=/);
  });

  it("writes chain data to the page as text only", () => {
    for (const f of ["site/proof/receipt.mjs", "site/proof/lib/receipt.mjs", "site/proof/lib/qr.mjs"])
      expect(read(f), f).not.toMatch(
        /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/,
      );
  });

  it("the receipt verifier can only read: it uses the read-only RPC client and sends no transaction", () => {
    const lib = read("site/proof/lib/receipt.mjs");
    expect(lib).toMatch(/from "\.\/near-rpc\.mjs"/);
    expect(lib).not.toMatch(/broadcast_tx|send_tx|fetch\(/);
  });
});
