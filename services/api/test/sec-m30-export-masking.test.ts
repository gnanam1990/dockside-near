/**
 * External security audit (m30): a default (destinations=MASKED) audit export carries no full
 * party, funder or payout-destination account id, including the proposed, revoked and
 * activated-but-unbound destination-change targets in the embedded contract release view
 * (ADR-0009 item 9). Only destinations=full for parties may carry them.
 * Simulated: NEAR (compiled escrow wasm on the simulated host), not testnet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../../packages/authority/test/helpers.js";
import { ALT_DEST, DAY, relogin, SUPPLIER_ACCT } from "../../../packages/release/test/chain.js";
import { maskAccount } from "../src/export.js";
import { type ApiWorld, apiWorld, lockAndApprove } from "./m07-world.js";

const REDIRECT_DEST = "harbor-redirect.testnet";

let a: ApiWorld;
beforeAll(async () => {
  a = await apiWorld();
  await lockAndApprove(a, "mask-intent-0001");
});
afterAll(async () => {
  await a.close();
});

const actor = (role: string) => a.actors[role] as Actor;
const path = (suffix: string) => `/v1/trades/${a.w.c.t}${suffix}`;

async function maskedExport(): Promise<string> {
  const auditor = actor("auditor");
  relogin(auditor);
  const res = await a.http(auditor, "GET", path("/audit-export"));
  expect(res.status, res.text).toBe(200);
  expect(res.json.destinations).toBe("MASKED");
  return res.text;
}

describe("m30: masked audit export hides destination-change targets", () => {
  it("a proposed and then revoked unilateral destination is masked", async () => {
    const c = a.w.c;
    const supplier = actor("supplier");
    relogin(supplier);
    const s = c.rel.successorTerms(c.t, REDIRECT_DEST);
    const one = await a.http(supplier, "POST", path("/destination-consents"), {
      destination: REDIRECT_DEST,
      signature: c.sign(supplier, "TRADE_REVISION", s.canonical),
    });
    a.relay(one);
    expect((await c.escrow.getRelease(c.t)).pendingDestinationChange?.toDestination).toBe(REDIRECT_DEST);
    const proposed = await maskedExport();
    expect(proposed).not.toContain(REDIRECT_DEST);
    expect(proposed).toContain(maskAccount(REDIRECT_DEST));
    expect(proposed).not.toContain(SUPPLIER_ACCT);

    const rch = await a.http(supplier, "POST", path("/destination-revocation-challenges"));
    expect(rch.status, rch.text).toBe(201);
    const rv = await a.http(supplier, "POST", path("/destination-revocations"), {
      payload: rch.json.payload,
      signature: a.sign(supplier, "DESTINATION_CHANGE_REVOKE", rch.json.payload),
    });
    a.relay(rv);
    const history = (await c.escrow.getRelease(c.t)).destinationHistory;
    expect(history.some((h) => h.toDestination === REDIRECT_DEST && h.status === "REVOKED")).toBe(true);
    const revoked = await maskedExport();
    expect(revoked).not.toContain(REDIRECT_DEST);
    expect(revoked).toContain(maskAccount(REDIRECT_DEST));
  });

  it("an activated but not yet bound destination is masked; full export for a party keeps it", async () => {
    const c = a.w.c;
    const buyer = actor("buyer");
    const supplier = actor("supplier");
    relogin(buyer);
    relogin(supplier);
    const ch = await a.http(supplier, "POST", path("/destination-change-challenges"), {
      destination: ALT_DEST,
    });
    expect(ch.status, ch.text).toBe(201);
    for (const p of [supplier, buyer]) {
      const res = await a.http(p, "POST", path("/destination-consents"), {
        destination: ALT_DEST,
        signature: a.sign(p, "TRADE_REVISION", ch.json.payload),
      });
      a.relay(res);
    }
    const consented = await maskedExport();
    expect(consented).not.toContain(ALT_DEST);
    c.advance(DAY + 1);
    relogin(buyer);
    relogin(supplier);
    a.relay(await a.http(supplier, "POST", path("/destination-activation")));
    expect((await c.escrow.getTrade(c.t)).payoutDestination).toBe(ALT_DEST);
    const activated = await maskedExport();
    expect(activated).not.toContain(ALT_DEST);
    expect(activated).toContain(maskAccount(ALT_DEST));
    // A party's full export is unchanged by masking.
    relogin(buyer);
    const full = await a.http(buyer, "GET", path("/audit-export?destinations=full"));
    expect(full.status, full.text).toBe(200);
    expect(full.json.destinations).toBe("FULL");
    expect(full.text).toContain(ALT_DEST);
    expect(full.text).toContain(REDIRECT_DEST);
  });
});
