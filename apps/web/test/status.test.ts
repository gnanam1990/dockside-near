/**
 * Status vocabulary and rendering (UI-SPEC §3.3, §3.7, §8): locked/unknown states can never
 * look paid, dry compatibility is always labelled as moving no funds, each dimension is
 * rendered separately with source and time, and unknown values never borrow a meaning.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoneyValue } from "../src/components/Data";
import { StatusBadge } from "../src/components/Status";
import { formatUnits, formatUtc } from "../src/lib/format";
import { describeStatus, VOCABULARY } from "../src/lib/status";

const LOCKED = ["SUBMITTING", "PROCESSING", "UNKNOWN", "REVIEW", "RECONCILING", "ADJUDICATION"];

describe("payout vocabulary", () => {
  const p = VOCABULARY.payoutState;
  it("covers the TDD release/payout states", () => {
    for (const s of [
      "VALUE_LOCKED",
      "DIRECT_TESTNET_AUTHORIZED",
      "FUNDED_AUTHORIZATION_REQUIRED",
      "FUNDED_AUTHORIZED",
      "FUNDED_AUTHORIZATION_EXPIRED",
      ...LOCKED,
      "PAID",
      "FAILED",
      "REFUNDED",
      "CANCELLED_PRE_SUBMIT",
      "ABANDONED_PRE_SUBMIT",
      "SUPERSEDED_PRE_SUBMIT",
      "INTENT_EXPIRED",
    ])
      expect(p[s], s).toBeDefined();
  });
  it("every state has a distinct label", () => {
    const labels = Object.values(p).map((m) => m.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("locked states are locked, never positive, never share the paid icon, and say no override exists", () => {
    for (const s of LOCKED) {
      const m = p[s];
      expect(m?.locked, s).toBe(true);
      expect(m?.tone, s).not.toBe("positive");
      expect(m?.icon, s).not.toBe(p["PAID"]?.icon);
      if (s !== "SUBMITTING") expect(m?.sentence, s).toMatch(/No retry, exit or terminal override/);
    }
  });
  it("PAID is the only positive payout state and names the terminal evidence", () => {
    const positive = Object.entries(p).filter(([, m]) => m.tone === "positive");
    expect(positive.map(([k]) => k)).toEqual(["PAID"]);
    expect(p["PAID"]?.label).toMatch(/terminal evidence/);
  });
  it("FAILED states the authoritative no-transfer disposition and the new-intent requirement", () => {
    expect(p["FAILED"]?.label).toMatch(/no transfer/);
    expect(p["FAILED"]?.sentence).toMatch(/new intent/);
  });
});

describe("independent dimensions", () => {
  it("dry compatibility is never positive and always says no funds moved", () => {
    for (const [k, m] of Object.entries(VOCABULARY.dryCompatibility)) {
      expect(m.tone, k).not.toBe("positive");
      expect(m.label, k).toMatch(/^Dry compatibility/);
      expect(m.sentence, k).toMatch(/No funds moved; not used for testnet release/);
    }
  });
  it("dry PASS, WORKING_TESTNET, provider refund and destination receipt are distinct", () => {
    const items = [
      describeStatus("dryCompatibility", "PASS"),
      describeStatus("productGate", "WORKING_TESTNET"),
      describeStatus("destinationReceipt", "PROVIDER_REFUND"),
      describeStatus("destinationReceipt", "RECEIVED"),
      describeStatus("payoutState", "PAID"),
      describeStatus("payoutState", "FUNDED_AUTHORIZED"),
      describeStatus("payoutState", "PROCESSING"),
    ];
    expect(new Set(items.map((m) => m.label)).size).toBe(items.length);
    expect(new Set(items.map((m) => m.icon)).size).toBe(items.length);
  });
  it("expired-unresolved holds stay blocking", () => {
    expect(VOCABULARY.holdState["EXPIRED_UNRESOLVED"]?.locked).toBe(true);
    expect(VOCABULARY.holdState["EXPIRED_UNRESOLVED"]?.sentence).toMatch(/does not clear/);
  });
  it("an unrecognized value is reported as unsupported, not mapped to a known meaning", () => {
    const m = describeStatus("payoutState", "PAID_MAYBE");
    expect(m.tone).toBe("unknown");
    expect(m.label).toContain("PAID_MAYBE");
    expect(m.sentence).toMatch(/unsupported schema/);
  });
});

describe("rendering", () => {
  it("a badge carries icon (hidden from AT), text label, sentence, source and exact time", () => {
    const at = Date.UTC(2026, 10, 11, 9, 30, 0);
    const html = renderToStaticMarkup(
      createElement(StatusBadge, {
        dimension: "payoutState",
        value: "UNKNOWN",
        source: "GET /v1/trades/x",
        observedAt: at,
      }),
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Outcome unknown");
    expect(html).toContain("No retry, exit or terminal override");
    expect(html).toContain("Source: GET /v1/trades/x");
    expect(html).toContain(formatUtc(at));
    expect(html).toContain("tone-unknown");
  });
  it("money uses exact integer units with asset and network", () => {
    const html = renderToStaticMarkup(
      createElement(MoneyValue, {
        value: { amount: "12500000000000000000000000", asset: "NEAR", decimals: 24, network: "near-testnet" },
      }),
    );
    expect(html).toContain("12.5 NEAR");
    expect(html).toContain("NEAR testnet");
  });
  it("formatUnits never rounds and never coerces malformed amounts", () => {
    expect(formatUnits("1", 24)).toBe("0.000000000000000000000001");
    expect(formatUnits("340282366920938463463374607431768211455", 24)).toBe(
      "340,282,366,920,938.463463374607431768211455",
    );
    expect(formatUnits("1000000", 0)).toBe("1,000,000");
    expect(() => formatUnits("-1", 24)).toThrow();
    expect(() => formatUnits("1.5", 24)).toThrow();
    expect(() => formatUnits("", 24)).toThrow();
  });
});
