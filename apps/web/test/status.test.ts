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

describe("backend vocabularies served since M04/M05 (release journal, operation journal)", () => {
  const LOCKED_OPS = [
    "SUBMITTING",
    "EXECUTING",
    "PROCESSING",
    "UNKNOWN",
    "REVIEW",
    "RECONCILING",
    "ADJUDICATION",
  ];
  it("every release-intent state the contract or journal can report has its own label", async () => {
    const { RELEASE_INTENT_STATES } = await import("@dockside/near");
    const labels = new Set<string>();
    for (const s of [...RELEASE_INTENT_STATES, "PREPARED", "EXPIRED_UNSIGNED"]) {
      const m = describeStatus("releaseIntentState", s);
      expect(m.label, s).not.toMatch(/^Unrecognized/);
      labels.add(m.label);
    }
    expect(labels.size).toBe(RELEASE_INTENT_STATES.length + 2);
  });
  it("every economic-operation state has its own label; locked states are never positive and never PAID-like", async () => {
    const { OPERATION_STATES } = await import("@dockside/journal");
    const labels = new Set<string>();
    for (const s of OPERATION_STATES) {
      const m = describeStatus("operationState", s);
      expect(m.label, s).not.toMatch(/^Unrecognized/);
      labels.add(m.label);
      if (LOCKED_OPS.includes(s)) {
        expect(m.locked, s).toBe(true);
        expect(m.tone, s).not.toBe("positive");
        expect(m.icon, s).not.toBe(describeStatus("operationState", "PAID").icon);
      }
    }
    expect(labels.size).toBe(OPERATION_STATES.length);
    const positive = OPERATION_STATES.filter(
      (s: string) => describeStatus("operationState", s).tone === "positive",
    );
    expect(positive).toEqual(["PAID"]);
  });
  it("attestation, inspection and slot vocabularies cover the evidence service values", () => {
    for (const s of ["CURRENT", "SUPERSEDED", "EXPIRED", "STALE", "INVALIDATED"])
      expect(describeStatus("attestationStatus", s).label).not.toMatch(/^Unrecognized/);
    for (const s of ["PASS", "FAIL", "REVIEW"])
      expect(describeStatus("inspectionDecision", s).label).not.toMatch(/^Unrecognized/);
    for (const s of ["MISSING", "UNDERFILLED", "STALE", "FILLED"])
      expect(describeStatus("slotStatus", s).label).not.toMatch(/^Unrecognized/);
    for (const s of ["PENDING_PROOF", "WAITING", "COMPLETED", "CANCELLED"])
      expect(describeStatus("recoveryStatus", s).label).not.toMatch(/^Unrecognized/);
    for (const s of ["PENDING_PROOF", "ACTIVE", "REVOKED"])
      expect(describeStatus("enrollmentStatus", s).label).not.toMatch(/^Unrecognized/);
    // Every binding issue the authority service reports says a new trade revision is required.
    for (const s of [
      "KEY_SUPERSEDED",
      "KEY_REVOKED",
      "KEY_NOT_BOUND",
      "CAPABILITY_MISSING",
      "SCOPE_MISMATCH",
    ]) {
      const m = describeStatus("bindingIssue", s);
      expect(m.label).not.toMatch(/^Unrecognized/);
      expect(m.tone).toBe("negative");
      expect(m.sentence).toMatch(/new trade revision is required/);
    }
    expect(describeStatus("attestorCoverage", "SCOPE_MISMATCH").label).toBe("Wrong scope");
    // No key-management value borrows a positive tone either.
    for (const d of ["recoveryStatus", "enrollmentStatus", "attestorCoverage"] as const)
      for (const s of ["COMPLETED", "ACTIVE", "COVERS"])
        expect(describeStatus(d, s).tone).not.toBe("positive");
    // No evidence-side value borrows a positive tone: completeness is not payment.
    for (const d of ["attestationStatus", "inspectionDecision", "slotStatus"] as const)
      for (const s of ["CURRENT", "PASS", "FILLED"]) expect(describeStatus(d, s).tone).not.toBe("positive");
  });
});

describe("refund and destination-change vocabularies (M10)", () => {
  const REFUND_STATES = [
    "REQUESTED",
    "TIMELOCKED",
    "AUTHORIZED",
    "EXECUTING",
    "PROCESSING",
    "UNKNOWN",
    "REVIEW",
    "RECONCILING",
    "ADJUDICATION",
    "REFUNDED",
    "FAILED",
    "REVOKED",
  ];
  it("covers every contract refund state with a distinct label; none is positive or looks paid", () => {
    const paid = describeStatus("payoutState", "PAID");
    const labels = REFUND_STATES.map((s) => describeStatus("refundState", s).label);
    expect(new Set(labels).size).toBe(REFUND_STATES.length);
    for (const s of REFUND_STATES) {
      const m = describeStatus("refundState", s);
      expect(m.label, s).not.toMatch(/^Unrecognized/);
      expect(m.tone, s).not.toBe("positive");
      expect(m.icon, s).not.toBe(paid.icon);
    }
  });
  it("live refund states keep the slice locked; only REFUNDED, FAILED and REVOKED are terminal", () => {
    for (const s of REFUND_STATES) {
      const m = describeStatus("refundState", s);
      const terminal = ["REFUNDED", "FAILED", "REVOKED"].includes(s);
      expect(Boolean(m.terminal), s).toBe(terminal);
      expect(Boolean(m.locked), s).toBe(!terminal);
    }
    expect(describeStatus("refundState", "FAILED").sentence).toMatch(/new refund intent/);
    expect(describeStatus("refundState", "REVOKED").sentence).toMatch(/source bucket/);
  });
  it("destination-change states are distinct and say a single consent never activates", () => {
    const states = ["PROPOSED", "CONSENTED", "ACTIVATED", "REVOKED", "EXPIRED"];
    const labels = states.map((s) => describeStatus("destinationChange", s).label);
    expect(new Set(labels).size).toBe(states.length);
    expect(describeStatus("destinationChange", "PROPOSED").sentence).toMatch(/never activate/);
    expect(describeStatus("destinationChange", "ACTIVATED").sentence).toMatch(/renewed/);
  });
});

describe("unexpected-asset recovery vocabularies (M11)", () => {
  const dims = {
    assetRecord: [
      "ASSET_RECOVERY_REVIEW",
      "UNRECOVERABLE_OR_REVIEW",
      "RECOVERY_REQUESTED",
      "RECOVERY_CHALLENGE_PERIOD",
      "RECOVERY_SUBMITTED",
      "RECOVERED",
    ],
    assetRecovery: [
      "REQUESTED",
      "CHALLENGE_PERIOD",
      "SUBMITTING",
      "UNKNOWN",
      "SUBMITTED",
      "REVIEW",
      "RECOVERED",
      "FAILED",
      "CHALLENGED",
      "REVOKED",
    ],
    assetOperation: [
      "QUEUED",
      "SUBMITTING",
      "UNKNOWN",
      "PROCESSING",
      "RECOVERED",
      "FAILED",
      "NOT_SUBMITTED",
      "REVIEW",
    ],
  } as const;
  const paid = describeStatus("payoutState", "PAID");
  for (const [dim, states] of Object.entries(dims) as [keyof typeof dims, readonly string[]][]) {
    it(`${dim}: every state is known, distinct, never positive and never shares the paid icon`, () => {
      const labels = states.map((s) => describeStatus(dim, s).label);
      expect(new Set(labels).size).toBe(states.length);
      for (const s of states) {
        const m = describeStatus(dim, s);
        expect(m.label, s).not.toMatch(/^Unrecognized/);
        expect(m.tone, s).not.toBe("positive");
        expect(m.icon, s).not.toBe(paid.icon);
      }
    });
  }
  it("unknown and submitted recoveries are locked and say no retry exists", () => {
    for (const s of ["SUBMITTING", "UNKNOWN", "SUBMITTED"]) {
      const m = describeStatus("assetRecovery", s);
      expect(m.locked, s).toBe(true);
      expect(m.sentence, s).toMatch(/No retry/);
    }
    expect(describeStatus("assetRecovery", "UNKNOWN").tone).toBe("unknown");
    expect(describeStatus("assetRecovery", "FAILED").sentence).toMatch(/new request/);
    expect(describeStatus("assetRecord", "ASSET_RECOVERY_REVIEW").sentence).toMatch(
      /never credited as native NEAR/,
    );
  });
});
