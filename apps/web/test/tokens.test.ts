/**
 * Semantic token contrast (UI-SPEC §4: verify every foreground/background pair at WCAG 2.2 AA)
 * for light and dark schemes, and the rule that component styles use tokens only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = fileURLToPath(new URL("../src/styles/", import.meta.url));
const src = fileURLToPath(new URL("../src/", import.meta.url));
const css = readFileSync(join(styles, "tokens.css"), "utf8");

function block(selectorStart: number): Record<string, string> {
  const open = css.indexOf("{", selectorStart);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(open, end).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/g))
    out[m[1] as string] = m[2] as string;
  return out;
}

const light = block(css.indexOf(":root"));
const dark = { ...light, ...block(css.indexOf(":root", css.indexOf("prefers-color-scheme: dark"))) };

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const TEXT = [
  "text-primary",
  "text-secondary",
  "action-secondary",
  "status-positive",
  "status-warning",
  "status-negative",
  "status-unknown",
];
const SURFACES = ["surface-canvas", "surface-panel"];
const NON_TEXT = ["border-control", "focus-ring", "action-primary"];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s scheme", (_name, t) => {
  it("defines every required token", () => {
    for (const k of [
      ...TEXT,
      ...SURFACES,
      ...NON_TEXT,
      "surface-subtle",
      "on-action-primary",
      "border-default",
      "border-subtle",
      "surface-hover",
      "surface-selected",
      "tint-positive",
      "tint-warning",
      "tint-negative",
      "tint-unknown",
      "tint-neutral",
    ])
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
  });
  for (const fg of TEXT)
    for (const bg of SURFACES)
      it(`${fg} on ${bg} meets 4.5:1`, () => {
        expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(4.5);
      });
  it("primary and secondary text on surface-subtle (table headers, selected nav) meet 4.5:1", () => {
    for (const fg of ["text-primary", "text-secondary"])
      expect(contrast(t[fg] as string, t["surface-subtle"] as string)).toBeGreaterThanOrEqual(4.5);
  });
  it("status text, links and body text on their tinted fills (callouts, badges) meet 4.5:1", () => {
    const tints: Record<string, string> = {
      "tint-positive": "status-positive",
      "tint-warning": "status-warning",
      "tint-negative": "status-negative",
      "tint-unknown": "status-unknown",
      "tint-neutral": "text-secondary",
    };
    for (const [tint, own] of Object.entries(tints))
      for (const fg of [own, "text-primary", "text-secondary", "action-secondary"])
        expect(contrast(t[fg] as string, t[tint] as string), `${fg} on ${tint}`).toBeGreaterThanOrEqual(4.5);
  });
  it("text and status on hover, selected and neutral surfaces (table rows, current navigation) meets 4.5:1", () => {
    for (const bg of ["surface-hover", "surface-selected", "tint-neutral"])
      for (const fg of [...TEXT, "action-primary"])
        expect(contrast(t[fg] as string, t[bg] as string), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
  it("button text on action-primary meets 4.5:1", () => {
    expect(contrast(t["on-action-primary"] as string, t["action-primary"] as string)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
  it("navigation text on the harbour rail and its hover/selected fills meets 4.5:1; rail focus and accent meet 3:1", () => {
    for (const bg of ["rail-bg", "rail-hover", "rail-selected"]) {
      for (const fg of ["rail-text", "rail-text-muted"])
        expect(contrast(t[fg] as string, t[bg] as string), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const fg of ["rail-focus", "rail-accent"])
        expect(contrast(t[fg] as string, t[bg] as string), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
  it("document ink rules are visible on canvas and panel (3:1)", () => {
    for (const bg of SURFACES)
      expect(contrast(t["ink-rule"] as string, t[bg] as string)).toBeGreaterThanOrEqual(3);
  });
  for (const fg of NON_TEXT)
    for (const bg of SURFACES)
      it(`${fg} on ${bg} meets 3:1 (non-text UI component)`, () => {
        expect(contrast(t[fg] as string, t[bg] as string)).toBeGreaterThanOrEqual(3);
      });
});

describe("component styles use semantic tokens only", () => {
  it("no raw colour literal outside tokens.css", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(e.name) && e.name !== "tokens.css") files.push(p);
      }
    };
    walk(src);
    const offenders = files.filter((f) =>
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
