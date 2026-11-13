import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import jsQR from "jsqr";
import { MANIFEST } from "../../../scripts/proof/build-manifest.mjs";
import { loadRecording, type Replay, startReplay } from "../../../scripts/proof/replay-rpc.mjs";
import { startSite } from "../../../scripts/proof/serve.mjs";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS } from "../e2e/helpers";

/**
 * The payment receipt page (site/proof/receipt.html, M54) in a real browser: the committed page,
 * served unchanged with its content security policy in force. Its requests for the public NEAR RPC
 * endpoints are routed to a local server replaying REAL recorded testnet answers
 * (fixtures/proof/testnet-receipt-recording.json), unchanged or with exactly one fact altered.
 * Nothing reaches the network, and there is no test double: every answer is the recording.
 */
const SITE_PORT = Number(process.env["DOCKSIDE_E2E_RECEIPT_SITE_PORT"] ?? 9043);
const REPLAY_PORT = Number(process.env["DOCKSIDE_E2E_RECEIPT_RPC_PORT"] ?? 9044);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const TESTNET_HOSTS = manifest.networks.testnet.rpc.map((u: string) => new URL(u).host);
const CORS = { "access-control-allow-origin": "*" };
const RELEASE = "trd_197c633d724eeb2cddc64d6dabf55976";
const HOLD = "trd_75c1de55a8c9f1aa532ec37eb611f46f";
const REFUND = "trd_a54930d5d5af718e0fc8a8c9d43b9a2d";
const RELEASE_TX = "9Wpr243gsWkQuKFbtmBrKMiGkXCPXp3MDfN8M1qrkcEn";

let site: { url: string; close(): Promise<void> };
let replay: Replay;
test.beforeAll(async () => {
  site = await startSite({ port: SITE_PORT });
  replay = await startReplay({ port: REPLAY_PORT, recording: loadRecording("testnet-receipt") });
});
test.afterAll(async () => {
  await site.close();
  await replay.close();
});

async function routeRpc(page: Page, variant: string): Promise<{ testnet: number; other: string[] }> {
  const seen = { testnet: 0, other: [] as string[] };
  await page.route(
    (url) => url.origin !== new URL(site.url).origin,
    async (route) => {
      const req = route.request();
      if (!TESTNET_HOSTS.includes(new URL(req.url()).host)) {
        seen.other.push(req.url());
        return route.abort();
      }
      if (req.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
      seen.testnet++;
      const res = await fetch(replay.url(variant), { method: "POST", body: req.postData() ?? "" });
      return route.fulfill({
        status: res.status,
        body: await res.text(),
        headers: { ...CORS, "content-type": "application/json" },
      });
    },
  );
  return seen;
}

const receipt = (q: string) => `${site.url}receipt.html?${q}`;
const verdict = (page: Page) => page.locator("[data-verdict]");
const check = (page: Page, id: string) => page.locator(`tr[data-check="${id}"]`);
const fact = (page: Page, id: string) => page.locator(`[data-fact="${id}"] dd`);

/** Reads the QR code the page drew: its SVG path, rasterised here and decoded by jsQR. */
async function readQr(page: Page): Promise<string | null> {
  const { d, view } = await page.locator("svg.qr").evaluate((svg) => ({
    d: svg.querySelector("path")?.getAttribute("d") ?? "",
    view: svg.getAttribute("viewBox"),
  }));
  const [, , n] = (view ?? "").split(" ").map(Number) as [number, number, number];
  const quiet = 4;
  const scale = 4;
  const px = n * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (const m of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const x = Number(m[1]) + quiet;
    const y = Number(m[2]) + quiet;
    for (let dy = 0; dy < scale; dy++)
      for (let dx = 0; dx < scale; dx++) {
        const p = ((y * scale + dy) * px + x * scale + dx) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
      }
  }
  return jsQR(rgba, px, px)?.data ?? null;
}

test("a paid trade's receipt is verified in the browser, with every check and fact listed", async ({
  page,
}) => {
  const seen = await routeRpc(page, "recorded");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(receipt(`trade=${RELEASE}&network=testnet`));
  await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
  await expect(verdict(page)).toContainText("Verified: all 9 checks passed");
  await expect(verdict(page)).toContainText(/final block \d+ .* with \d+ read-only requests/);
  await expect(page.locator('tr[data-status="PASS"]')).toHaveCount(9);
  await expect(fact(page, "amount")).toHaveText("0.05 NEAR");
  await expect(fact(page, "asset")).toHaveText("NEAR (native)");
  await expect(fact(page, "buyer")).toHaveText("gnanam1990-dock-buyer.testnet");
  await expect(fact(page, "supplier")).toHaveText("gnanam1990-dock-supplier.testnet");
  await expect(fact(page, "paid-to")).toHaveText("gnanam1990-dock-supplier.testnet");
  await expect(fact(page, "inspection")).toContainText("PASS (DOCS_MATCH)");
  await expect(fact(page, "release")).toHaveText("rli_abb154c802f92362dc09d32fe48888be PAID");
  await expect(fact(page, "code-hash")).toHaveText("7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N");
  await expect(fact(page, "tx").getByRole("link")).toHaveAttribute(
    "href",
    `https://testnet.nearblocks.io/txns/${RELEASE_TX}`,
  );
  await expect(check(page, "release-transfer")).toContainText(
    "0.05 NEAR to gnanam1990-dock-supplier.testnet",
  );
  // The QR code carries this receipt's address with the verified transaction pinned in it.
  const qr = await readQr(page);
  expect(qr).toBe(receipt(`trade=${RELEASE}&network=testnet&tx=${RELEASE_TX}`));
  await expect(page.locator("figure.qr-figure figcaption")).toContainText(qr ?? "");
  expect(seen.testnet).toBeGreaterThan(0);
  expect(seen.other).toEqual([]);
  expect(errors).toEqual([]);
});

test("the address the QR code carries verifies the same receipt", async ({ page }) => {
  await routeRpc(page, "recorded");
  await page.goto(receipt(`trade=${HOLD}&network=testnet`));
  await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
  const qr = await readQr(page);
  expect(qr).toContain("&tx=");
  await page.goto(qr ?? "");
  await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
  await expect(fact(page, "tx")).toContainText("2uSgWxtFqF5N9GRj5d7BR44B3xZnfy5ESjFh6KAKvGGf");
});

test("a chain that disagrees with the receipt is red, and the failing check is named", async ({ page }) => {
  await routeRpc(page, "transfer-recipient");
  await page.goto(receipt(`trade=${RELEASE}`));
  await expect(verdict(page)).toHaveAttribute("data-verdict", "FAIL");
  await expect(verdict(page)).toContainText("Not verified: 1 of 9 checks did not pass");
  await expect(check(page, "release-transfer")).toHaveAttribute("data-status", "FAIL");
  await expect(check(page, "release-transfer")).toContainText("someone-else.testnet");
});

test("a trade that paid nobody has no valid receipt", async ({ page }) => {
  await routeRpc(page, "recorded");
  await page.goto(receipt(`trade=${REFUND}`));
  await expect(verdict(page)).toHaveAttribute("data-verdict", "FAIL");
  await expect(check(page, "release-intent")).toContainText("no PAID release intent");
  await expect(fact(page, "amount")).toHaveText("no paid release");
});

test("an unreachable endpoint is red, and verifying again recovers", async ({ page }) => {
  let down = true;
  await page.route(
    (url) => url.origin !== new URL(site.url).origin,
    async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS")
        return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
      const res = await fetch(replay.url(down ? "down" : "recorded"), {
        method: "POST",
        body: req.postData() ?? "",
      });
      return route.fulfill({
        status: res.status,
        body: await res.text(),
        headers: { ...CORS, "content-type": "application/json" },
      });
    },
  );
  await page.goto(receipt(`trade=${RELEASE}`));
  await expect(verdict(page)).toHaveAttribute("data-verdict", "FAIL");
  await expect(verdict(page)).toContainText("could not be reached");
  down = false;
  await page.getByRole("button", { name: "Verify again" }).click();
  await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
});

test("without a trade the page names the receipts it can verify and sends no request", async ({ page }) => {
  const seen = await routeRpc(page, "recorded");
  await page.goto(receipt(""));
  await expect(verdict(page)).toContainText("No receipt named");
  await expect(page.getByRole("link", { name: RELEASE })).toHaveAttribute(
    "href",
    `?trade=${RELEASE}&network=testnet`,
  );
  await expect(page.getByRole("link", { name: REFUND })).toHaveCount(0);
  await page.goto(receipt(`trade=${RELEASE}&network=mainnet`));
  await expect(verdict(page)).toContainText("Not deployed yet");
  expect(seen.testnet).toBe(0);
});

test("the proof page links each paid trade to its receipt", async ({ page }) => {
  await routeRpc(page, "recorded");
  await page.goto(site.url);
  await expect(page.locator(`a[data-receipt="${RELEASE}"]`)).toHaveAttribute(
    "href",
    `./receipt.html?trade=${RELEASE}&network=testnet`,
  );
  await expect(page.locator(`a[data-receipt="${REFUND}"]`)).toHaveCount(0);
});

test("prints without its buttons and notes; accessible and without overflow at every width", async ({
  page,
}) => {
  await routeRpc(page, "recorded");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, media: "screen" });
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.goto(receipt(`trade=${RELEASE}`));
      await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
      await expectNoBodyOverflow(page, `receipt ${scheme} ${v.name}`);
      if (v.name === "375" || v.name === "1440") await expectAccessible(page, `receipt ${scheme} ${v.name}`);
    }
  }
  await page.emulateMedia({ media: "print", colorScheme: "light" });
  await expect(page.getByRole("button", { name: "Print receipt" })).toBeHidden();
  await expect(page.locator("section.notes")).toBeHidden();
  await expect(page.locator("svg.qr")).toBeVisible();
  await expect(check(page, "release-tx")).toBeVisible();
});
