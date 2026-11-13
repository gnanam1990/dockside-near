/** M52: exact amount entry and pasted-quote parsing of the supplier cash-out panel. */
import { describe, expect, it } from "vitest";
import { parsePastedQuote, toBaseUnits } from "../src/lib/cash-out";

describe("cash-out panel helpers", () => {
  it("converts a decimal entry to base units exactly, and refuses instead of rounding", () => {
    expect(toBaseUnits("2", 6)).toEqual({ ok: true, value: "2000000" });
    expect(toBaseUnits(" 2.5 ", 6)).toEqual({ ok: true, value: "2500000" });
    expect(toBaseUnits("0.000001", 6)).toEqual({ ok: true, value: "1" });
    expect(toBaseUnits("1,250.75", 6)).toEqual({ ok: true, value: "1250750000" });
    expect(toBaseUnits("123456789012345678.123456789012345678", 18)).toEqual({
      ok: true,
      value: "123456789012345678123456789012345678",
    });
    expect(toBaseUnits("7", 0)).toEqual({ ok: true, value: "7" });
    for (const bad of ["", "0", "0.0", "-1", "1e3", "2.", ".5", "abc", "0.0000001", "1 000"])
      expect(toBaseUnits(bad, 6).ok, bad).toBe(false);
  });

  it("accepts one JSON object as the pasted answer and nothing else", () => {
    expect(parsePastedQuote(' {"quote":{"depositAddress":"abc"}} ')).toEqual({
      ok: true,
      value: { quote: { depositAddress: "abc" } },
    });
    for (const bad of ["", "not json", "[]", "null", '"text"', "12", `{"a":"${"x".repeat(20_001)}"}`])
      expect(parsePastedQuote(bad).ok, bad.slice(0, 12)).toBe(false);
  });
});
