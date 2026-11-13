/**
 * M52: configuration of the 1Click endpoint used by the supplier cash-out panel. Fail closed: a
 * plain-http or path-carrying endpoint, a token file without an endpoint and a non-mainnet 1Click on
 * a public host all stop startup. The token itself is never a configuration value: only the path of
 * a file that holds it.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

const code = (env: Record<string, string>) => {
  try {
    loadConfig(env);
    return "OK";
  } catch (e) {
    const x = e as { code?: string; details?: { name?: string } };
    return `${x.code}:${x.details?.name ?? ""}`;
  }
};

describe("M52 1Click configuration", () => {
  it("is off by default and settles on mainnet unless a loopback simulator says otherwise", () => {
    const c = loadConfig({});
    expect(c.DOCKSIDE_ONE_CLICK_URL).toBeUndefined();
    expect(c.DOCKSIDE_ONE_CLICK_NEAR_NETWORK).toBe("near-mainnet");
    expect(loadConfig({ DOCKSIDE_ONE_CLICK_URL: "https://1click.example.org" }).DOCKSIDE_ONE_CLICK_URL).toBe(
      "https://1click.example.org",
    );
    const sim = loadConfig({
      DOCKSIDE_ONE_CLICK_URL: "http://127.0.0.1:9024",
      DOCKSIDE_ONE_CLICK_NEAR_NETWORK: "near-testnet",
    });
    expect(sim.DOCKSIDE_ONE_CLICK_NEAR_NETWORK).toBe("near-testnet");
  });

  it("refuses unsafe endpoints and inconsistent settings, naming only the variable", () => {
    expect(code({ DOCKSIDE_ONE_CLICK_URL: "http://1click.example.org" })).toBe(
      "CONFIG_INVALID:DOCKSIDE_ONE_CLICK_URL",
    );
    expect(code({ DOCKSIDE_ONE_CLICK_URL: "https://1click.example.org/v0" })).toBe(
      "CONFIG_INVALID:DOCKSIDE_ONE_CLICK_URL",
    );
    expect(code({ DOCKSIDE_ONE_CLICK_TOKEN_FILE: "token.txt" })).toBe(
      "CONFIG_INVALID:DOCKSIDE_ONE_CLICK_TOKEN_FILE",
    );
    // A token value is not a recognised variable: it cannot be placed in the environment by mistake.
    expect(
      code({ DOCKSIDE_ONE_CLICK_URL: "https://1click.example.org", DOCKSIDE_ONE_CLICK_JWT: "x".repeat(40) }),
    ).toBe("CONFIG_INVALID:");
    expect(
      code({
        DOCKSIDE_ONE_CLICK_URL: "https://1click.example.org",
        DOCKSIDE_ONE_CLICK_NEAR_NETWORK: "near-testnet",
      }),
    ).toBe("CONFIG_INVALID:DOCKSIDE_ONE_CLICK_NEAR_NETWORK");
    expect(code({ DOCKSIDE_ONE_CLICK_NEAR_NETWORK: "near-testnet" })).toBe(
      "CONFIG_INVALID:DOCKSIDE_ONE_CLICK_NEAR_NETWORK",
    );
  });
});
