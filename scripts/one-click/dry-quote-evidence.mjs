#!/usr/bin/env node
/**
 * One real `dry: true` 1Click quote, recorded as evidence for the supplier cash-out (M52).
 *
 * Run by the repository owner. It uses the same read-only client the API uses (build first:
 * `pnpm run build`), sends the token-list request and exactly one dry quote, creates no deposit
 * address and moves nothing. The optional partner token is read from the file named by
 * DOCKSIDE_ONE_CLICK_TOKEN_FILE and is never written to the output.
 *
 *   node scripts/one-click/dry-quote-evidence.mjs --refund-to <your-account.near> --recipient <0x address on Arbitrum> [--amount 2000000] [--out docs/evidence/M52/dry-quote.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildQuoteRequest, OneClickClient, quoteCost } from "../../packages/payout/dist/index.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const refundTo = arg("refund-to");
const recipient = arg("recipient");
if (!refundTo || !recipient) {
  process.stderr.write(
    "usage: dry-quote-evidence.mjs --refund-to <account.near> --recipient <0x...> [--amount <base units>] [--out <file>]\n",
  );
  process.exit(2);
}
const baseUrl = arg("url", "https://1click.chaindefuser.com");
const originAsset = arg("origin", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
const destinationAsset = arg(
  "destination",
  "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
);
const out = arg("out", "docs/evidence/M52/dry-quote.json");
const tokenFile = process.env["DOCKSIDE_ONE_CLICK_TOKEN_FILE"];
const jwt = tokenFile ? readFileSync(tokenFile, "utf8").trim() : undefined;
const client = new OneClickClient({ baseUrl, timeoutMs: 20_000, ...(jwt ? { bearer: jwt } : {}) });

const tokens = await client.tokens();
if (tokens.kind !== "OK") {
  process.stderr.write(`token list: ${JSON.stringify(tokens)}\n`);
  process.exit(1);
}
const find = (id) => tokens.value.find((t) => t.assetId === id);
const { dry: _dry, ...params } = buildQuoteRequest(
  {
    supplierAccountId: refundTo,
    originAsset,
    destinationAsset,
    amount: arg("amount", "2000000"),
    recipient,
    slippageBps: 100,
    deadlineMs: Date.now() + 30 * 60_000,
  },
  true,
);
const quote = await client.dryQuote(params);
const record = {
  what: "One real 1Click dry quote (dry: true). No deposit address was created and nothing was sent.",
  recordedAt: new Date().toISOString(),
  provider: baseUrl,
  authenticated: Boolean(jwt),
  tokensListed: tokens.value.length,
  origin: find(originAsset) ?? null,
  destination: find(destinationAsset) ?? null,
  request: { ...params, dry: true },
  result: quote,
  cost: quote.kind === "OK" ? quoteCost(quote.value.quote) : null,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${quote.kind}: wrote ${out}\n`);
process.exit(quote.kind === "OK" ? 0 : 1);
