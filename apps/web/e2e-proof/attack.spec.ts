import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { requestKey } from "../../../scripts/proof/replay-rpc.mjs";
import { startSite } from "../../../scripts/proof/serve.mjs";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS } from "../e2e/helpers";

/**
 * The attack console (site/proof/attack, M53) in a real browser: the committed page, served
 * unchanged with its content security policy in force.
 *
 * Data: the REAL answers of a local nearcore sandbox node, recorded by the M53 sandbox suite
 * (services/hosted/test/m53-attack-sandbox.test.ts, DOCKSIDE_M53_RECORD=1) after it ran run-all's
 * attack-demo journey and the five attacks through the production relay: fixtures/attack/
 * sandbox-recording.json (RPC answers), sandbox-demo.json (the demo config of that run) and
 * sandbox-relay-answers.json (what the HTTP relay returned for each attempt). The page's requests
 * for the public RPC endpoint and for its relay are answered from those files, unchanged or with
 * exactly one fact altered. Nothing reaches the network.
 */
const SITE_PORT = Number(process.env["DOCKSIDE_E2E_ATTACK_SITE_PORT"] ?? 9104);
const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/attack/${f}`, import.meta.url), "utf8"));
const recording = fixture("sandbox-recording.json") as { answers: Record<string, unknown> };
const demo = fixture("sandbox-demo.json") as Record<string, unknown> & {
  tradeId: string;
  attacker: { accountId: string };
};
const relayAnswers = fixture("sandbox-relay-answers.json") as {
  attack: string;
  txHash: string;
  code: string;
}[];
const RPC_HOST = "test.rpc.fastnear.com";
const CORS = { "access-control-allow-origin": "*" };

let site: { url: string; close(): Promise<void> };
test.beforeAll(async () => {
  site = await startSite({ port: SITE_PORT });
});
test.afterAll(async () => {
  await site.close();
});

type Mutate = (
  rpc: { method: string; params: Record<string, unknown> },
  result: Record<string, unknown>,
) => unknown;
const viewOf = (rpc: { params: Record<string, unknown> }) =>
  rpc.params["request_type"] === "call_function" ? String(rpc.params["method_name"]) : null;
const decode = (r: Record<string, unknown>) => JSON.parse(Buffer.from(r["result"] as number[]).toString());
const encode = (r: Record<string, unknown>, v: unknown) => ({
  ...r,
  result: [...Buffer.from(JSON.stringify(v))],
});

interface Opts {
  config?: Record<string, unknown>;
  relay?: "none" | "recorded";
  mutate?: Mutate;
  /** Answers for requests the recording does not hold (undefined: not recorded). */
  extra?: (rpc: { method: string; params: Record<string, unknown> }) => unknown;
}

/** Route the page's config, relay and RPC requests; returns counters of what it asked for. */
async function route(page: Page, o: Opts = {}) {
  const seen = { rpc: 0, relayPosts: 0, other: [] as string[] };
  const origin = new URL(site.url).origin;
  await page.route(`${origin}/attack/attack-demo.json`, (r) => r.fulfill({ json: o.config ?? demo }));
  await page.route(`${origin}/attack/api/**`, async (r) => {
    if (o.relay !== "recorded") return r.fulfill({ status: 404, body: "not found" });
    const url = new URL(r.request().url());
    if (url.pathname.endsWith("/status"))
      return r.fulfill({ json: { enabled: true, armed: true, attempts: "6" } });
    seen.relayPosts++;
    const { attack } = JSON.parse(r.request().postData() ?? "{}");
    const answer = relayAnswers.find((a) => a.attack === attack);
    return r.fulfill({ json: answer });
  });
  await page.route(
    (url) => url.origin !== origin,
    async (r) => {
      const req = r.request();
      if (new URL(req.url()).host !== RPC_HOST) {
        seen.other.push(req.url());
        return r.abort();
      }
      if (req.method() === "OPTIONS")
        return r.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
      seen.rpc++;
      const rpc = JSON.parse(req.postData() ?? "{}");
      const recorded = recording.answers[requestKey(rpc)] as Record<string, unknown> | undefined;
      const result =
        recorded === undefined
          ? o.extra?.(rpc)
          : o.mutate
            ? o.mutate(rpc, structuredClone(recorded))
            : recorded;
      const body =
        result === undefined
          ? { jsonrpc: "2.0", id: rpc.id, error: { name: "HANDLER_ERROR", cause: { name: "NOT_RECORDED" } } }
          : { jsonrpc: "2.0", id: rpc.id, result };
      return r.fulfill({ json: body, headers: CORS });
    },
  );
  return seen;
}

const open = async (page: Page) => {
  await page.goto(`${site.url}attack/`);
  await expect(page.locator("#trade")).toHaveAttribute("aria-busy", "false");
};

test("reads the demo trade from the chain: funds intact, the counter from the demo key's nonce", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const seen = await route(page);
  await open(page);
  await expect(page.locator(".verdict-title")).toHaveText("The money has not moved");
  await expect(page.locator("#attempt-count")).toHaveText("6");
  await expect(page.locator("#trade")).toContainText(demo.tradeId);
  await expect(page.locator("#trade")).toContainText("DIRECT_TESTNET_AUTHORIZED; blocked by HOLD_ACTIVE");
  await expect(page.locator("#trade")).toContainText("function-call key for the escrow only");
  for (const id of ["funded", "reserved", "released", "refunded", "refundLocked"])
    await expect(page.locator(`tr[data-row="${id}"]`)).toHaveAttribute("data-ok", "true");
  await expect(page.locator('tr[data-row="funded"] td').nth(1)).toHaveText("0.02 NEAR");
  expect(seen.other).toEqual([]);
  // The only failed request is the probe for a same-origin relay, which a static host answers 404.
  expect(errors.filter((e) => !e.includes("status of 404"))).toEqual([]);
});

test("with no relay it replays each recorded attempt by reading its transaction from the chain", async ({
  page,
}) => {
  const seen = await route(page, { relay: "none" });
  await open(page);
  await expect(page.locator("#mode")).toHaveAttribute("data-mode", "replay");
  const expected: Record<string, string> = {
    "change-payout": "SIGNATURE_INVALID",
    "release-during-hold": "HOLD_ACTIVE",
    "approve-wrong-key": "SIGNATURE_INVALID",
    "replay-approval": "INVALID_STATE",
    "refund-to-stranger": "NOTHING_ELIGIBLE",
  };
  for (const [id, code] of Object.entries(expected)) {
    const card = page.locator(`li[data-attack="${id}"]`);
    await card.getByRole("button", { name: "Replay recorded attempt" }).click();
    const result = card.locator(".result");
    await expect(result).toHaveAttribute("data-code", code);
    await expect(result).toHaveClass(/result-refused/);
    await expect(result).toContainText("Refused by the contract:");
    await expect(result).toContainText(`signed by ${demo.attacker.accountId}`);
  }
  await expect(page.locator('li[data-attack="release-during-hold"] .result')).toContainText(
    "Every blocker the contract listed: HOLD_ACTIVE, APPROVAL_STALE",
  );
  expect(seen.relayPosts).toBe(0);
});

test("live mode: the relay returns a hash, and the page shows what NEAR says about it", async ({ page }) => {
  const seen = await route(page, { relay: "recorded" });
  await open(page);
  await expect(page.locator("#mode")).toHaveAttribute("data-mode", "live");
  const card = page.locator('li[data-attack="replay-approval"]');
  await card.getByRole("button", { name: "Try it" }).click();
  await expect(card.locator(".result")).toHaveAttribute("data-code", "INVALID_STATE");
  await expect(card.locator(".result")).toContainText("release intent is DIRECT_TESTNET_AUTHORIZED");
  expect(seen.relayPosts).toBe(1);
});

test("an attempt the chain reports as successful is shown as not refused", async ({ page }) => {
  await route(page, {
    relay: "none",
    mutate: (rpc, r) =>
      rpc.method === "EXPERIMENTAL_tx_status"
        ? {
            ...r,
            receipts_outcome: (r["receipts_outcome"] as Record<string, Record<string, unknown>>[]).map(
              (o) => ({
                ...o,
                outcome: { ...o["outcome"], status: { SuccessValue: "" } },
              }),
            ),
          }
        : r,
  });
  await open(page);
  const card = page.locator('li[data-attack="release-during-hold"]');
  await card.getByRole("button", { name: "Replay recorded attempt" }).click();
  await expect(card.locator(".result")).toHaveClass(/result-other/);
  await expect(card.locator(".result")).toContainText("Not a refusal: SUCCEEDED");
});

test("a ledger that moved by one yoctoNEAR is shown as changed", async ({ page }) => {
  await route(page, {
    mutate: (rpc, r) => {
      if (viewOf(rpc) !== "get_ledger") return r;
      const v = decode(r);
      v.totals.released = (BigInt(v.totals.released) + 1n).toString();
      return encode(r, v);
    },
  });
  await open(page);
  await expect(page.locator(".verdict-title")).toHaveText("The trade is not in its demo state");
  await expect(page.locator('tr[data-row="released"]')).toHaveAttribute("data-ok", "false");
});

/**
 * The live demo trade holds test USDC (NEP-141, 6 decimals). The sandbox recording is a NEAR
 * trade, so this run alters exactly the asset: the config's amount and terms name the token, the
 * ledger reports the token and the same buckets in its base units, and the token contract answers
 * ft_metadata with its symbol.
 */
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const toUsdc = (v: string) => (v === "0" ? "0" : "2000000");
const usdcDemo = () => {
  const c = structuredClone(demo) as unknown as Record<string, unknown> & {
    terms: { struct: Record<string, unknown> };
  };
  c.amountYocto = "2000000";
  c.terms.struct["amountYocto"] = { u128: "2000000" };
  c.terms.struct["asset"] = {
    struct: {
      decimals: { u64: "6" },
      kind: { str: "NEP141" },
      network: { str: "near-testnet" },
      tokenAccountId: { str: USDC },
    },
  };
  return c;
};
const usdcLedger: Mutate = (rpc, r) => {
  if (viewOf(rpc) !== "get_ledger") return r;
  const v = decode(r);
  v.asset = { kind: "NEP141", network: "near-testnet", tokenAccountId: USDC, decimals: 6 };
  for (const k of Object.keys(v.totals))
    if (typeof v.totals[k] === "string" && /^\d+$/.test(v.totals[k])) v.totals[k] = toUsdc(v.totals[k]);
  return encode(r, v);
};
const ftMetadata = (rpc: { params: Record<string, unknown> }) =>
  viewOf(rpc) === "ft_metadata" && rpc.params["account_id"] === USDC
    ? {
        block_height: 1,
        block_hash: "11111111111111111111111111111111",
        logs: [],
        result: [
          ...Buffer.from(JSON.stringify({ spec: "ft-1.0.0", name: "USDC", symbol: "USDC", decimals: 6 })),
        ],
      }
    : undefined;

test("a USDC trade's amounts are stated in USDC at the token's decimals, never as NEAR", async ({ page }) => {
  await route(page, { config: usdcDemo(), mutate: usdcLedger, extra: ftMetadata });
  await open(page);
  await expect(page.locator(".verdict-title")).toHaveText("The money has not moved");
  await expect(page.locator("#trade .verdict")).toContainText("All 2.00 USDC is still funded and reserved");
  await expect(page.locator("#trade .readout-value").first()).toHaveText("2.00 USDC");
  for (const id of ["funded", "reserved"]) {
    await expect(page.locator(`tr[data-row="${id}"] td`).nth(0)).toHaveText("2.00 USDC");
    await expect(page.locator(`tr[data-row="${id}"] td`).nth(1)).toHaveText("2.00 USDC");
  }
  await expect(page.locator('tr[data-row="released"] td').nth(1)).toHaveText("0.00 USDC");
  await expect(page.locator("#trade")).not.toContainText(/[0-9] NEAR/);
});

test("a token without readable metadata is named by its contract, not as NEAR", async ({ page }) => {
  await route(page, { config: usdcDemo(), mutate: usdcLedger });
  await open(page);
  await expect(page.locator('tr[data-row="funded"] td').nth(1)).toHaveText(`2.00 tokens of ${USDC}`);
  await expect(page.locator("#trade")).not.toContainText(/[0-9] NEAR/);
});

test("an unreadable chain is reported, not passed", async ({ page }) => {
  await route(page, { mutate: () => undefined });
  await open(page);
  await expect(page.locator(".verdict-title")).toHaveText("The trade could not be read from NEAR");
  await expect(page.getByRole("button", { name: "Read again" })).toBeVisible();
});

test("before the demo exists the page says so and sends no request", async ({ page }) => {
  const committed = JSON.parse(
    readFileSync(new URL("../../../site/proof/attack/attack-demo.json", import.meta.url), "utf8"),
  );
  const notSetUp = {
    schema: committed.schema,
    network: committed.network,
    status: "NOT_SET_UP",
    rpc: committed.rpc,
    explorer: committed.explorer,
    relay: null,
    escrow: null,
    tradeId: null,
    releaseIntentId: null,
    holdId: null,
    amountYocto: null,
    parties: null,
    attacker: null,
    baselineNonce: null,
    setup: [],
    terms: null,
    approval: null,
    recorded: [],
  };
  const seen = await route(page, { config: notSetUp });
  await open(page);
  await expect(page.locator(".verdict-title")).toHaveText("The demo trade has not been created yet");
  expect(seen.rpc).toBe(0);
  expect(seen.relayPosts).toBe(0);
});

test("is accessible and fits every viewport in light and dark", async ({ page }) => {
  await route(page, { relay: "none" });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      await open(page);
      const card = page.locator('li[data-attack="release-during-hold"]');
      await card.getByRole("button", { name: "Replay recorded attempt" }).click();
      await expect(card.locator(".result")).toBeVisible();
      await expectNoBodyOverflow(page, `${scheme} ${v.name}`);
      await expectAccessible(page, `${scheme} ${v.name}`);
    }
  }
});
