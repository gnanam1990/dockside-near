/**
 * M06 skeleton: the dry-compatibility decision logic and the blocked adapter. These are unit tests
 * of pure functions only; no 1Click client, endpoint or credential is involved, so T-024..T-027,
 * T-048 and T-055 stay NOT_RUN (docs/status/M06.md).
 */
import { describe, expect, it } from "vitest";
import {
  BlockedOneClickAdapter,
  classifyDryProbe,
  type DryQuoteExpectation,
  dryCompatibleLabel,
  FUNDED_AUTHORIZATION_FIELDS,
  fundedAuthorizationGate,
} from "../src/index.js";

const expected: DryQuoteExpectation = {
  finalRecipient: "harbor-supplier.near",
  originNetwork: "near-mainnet",
  originAsset: "nep141:wrap.near",
  destinationNetwork: "near-mainnet",
  destinationAsset: "nep141:usdc.near",
  amountInYocto: 10n * 10n ** 24n,
  refundTo: "dockside-escrow.near",
};
const quote = { ...expected, recipient: expected.finalRecipient };

describe("M06 dry compatibility decision logic (skeleton)", () => {
  it("classifies NOT_RUN, UNKNOWN, INCOMPATIBLE and PASS", () => {
    expect(classifyDryProbe(expected, { kind: "NOT_ATTEMPTED", reason: "x" }).state).toBe("NOT_RUN");
    expect(classifyDryProbe(expected, { kind: "TIMEOUT" }).state).toBe("UNKNOWN");
    expect(classifyDryProbe(expected, { kind: "TRANSPORT_ERROR", code: "ECONNRESET" }).state).toBe("UNKNOWN");
    expect(classifyDryProbe(expected, { kind: "AMBIGUOUS", detail: "two amounts" }).state).toBe("UNKNOWN");
    expect(classifyDryProbe(expected, { kind: "RESPONSE", quote }).state).toBe("PASS");
  });

  it("every bound field mismatch is INCOMPATIBLE, including refundTo pointing at an executor", () => {
    const fields: [keyof typeof quote, unknown][] = [
      ["recipient", "attacker.near"],
      ["originNetwork", "eth-mainnet"],
      ["originAsset", "nep141:other.near"],
      ["destinationNetwork", "near-testnet"],
      ["destinationAsset", "nep141:usdt.near"],
      ["amountInYocto", 1n],
      ["refundTo", "relayer-executor.near"],
    ];
    for (const [k, v] of fields) {
      const r = classifyDryProbe(expected, { kind: "RESPONSE", quote: { ...quote, [k]: v } });
      expect(r.state, k).toBe("INCOMPATIBLE");
      expect(r.mismatches.length).toBe(1);
    }
  });

  it("only PASS exposes DRY_COMPATIBLE; the shipped adapter never probes", async () => {
    expect(dryCompatibleLabel("PASS")).toBe("DRY_COMPATIBLE");
    for (const s of ["NOT_RUN", "UNKNOWN", "INCOMPATIBLE"] as const) expect(dryCompatibleLabel(s)).toBeNull();
    const obs = await new BlockedOneClickAdapter().dryProbe();
    expect(classifyDryProbe(expected, obs).state).toBe("NOT_RUN");
  });

  it("the funded rail is blocked and the authorization design binds every economic field", () => {
    expect(() => fundedAuthorizationGate()).toThrow(expect.objectContaining({ code: "FUNDED_RAIL_BLOCKED" }));
    for (const f of [
      "quoteDigest",
      "depositAddress",
      "finalRecipient",
      "minAmountOut",
      "slippageBps",
      "capYocto",
      "refundTo",
      "nonce",
      "expiresAt",
    ])
      expect(FUNDED_AUTHORIZATION_FIELDS as readonly string[]).toContain(f);
  });
});
