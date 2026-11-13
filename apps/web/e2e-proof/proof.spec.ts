import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { MANIFEST } from "../../../scripts/proof/build-manifest.mjs";
import { type Replay, startReplay } from "../../../scripts/proof/replay-rpc.mjs";
import { startSite } from "../../../scripts/proof/serve.mjs";
import { base58Encode, hexToBytes } from "../../../site/proof/lib/near-rpc.mjs";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS } from "../e2e/helpers";

/**
 * The proof page (site/proof) in a real browser. The page is the committed one, served unchanged
 * with its content security policy in force. Its requests for the public NEAR RPC endpoints are
 * routed to a local server that replays REAL recorded testnet answers
 * (fixtures/proof/testnet-recording.json), unchanged or with exactly one fact altered. Nothing
 * reaches the network.
 *
 * The recording has no answer for the 1.1 MB contract download (view_code). The suite therefore
 * shows both sides of that row: with the committed manifest the download is unreadable and the
 * page must say so and must not show a pass; for the all-pass rendering the test answers the two
 * code queries itself with a small test artifact and its digest (the only test double; every other
 * answer is the recording).
 */
const SITE_PORT = Number(process.env["DOCKSIDE_E2E_PROOF_SITE_PORT"] ?? 9041);
const REPLAY_PORT = Number(process.env["DOCKSIDE_E2E_PROOF_RPC_PORT"] ?? 9042);
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const TESTNET_HOSTS = manifest.networks.testnet.rpc.map((u: string) => new URL(u).host);
const MAINNET_HOSTS = manifest.networks.mainnet.rpc.map((u: string) => new URL(u).host);
const CODE = Buffer.from(new Uint8Array(2048).map((_, i) => (i * 7) % 253));
const CODE_SHA256 = createHash("sha256").update(CODE).digest("hex");
const CODE_HASH = base58Encode(hexToBytes(CODE_SHA256));
const CORS = { "access-control-allow-origin": "*" };

let site: { url: string; close(): Promise<void> };
let replay: Replay;
test.beforeAll(async () => {
  site = await startSite({ port: SITE_PORT });
  replay = await startReplay({ port: REPLAY_PORT });
});
test.afterAll(async () => {
  await site.close();
  await replay.close();
});

type Seen = { testnet: number; mainnet: number; other: string[] };

/** Routes every request that leaves the page's own origin; returns what was seen. */
async function routeRpc(page: Page, variant: string, opts: { testArtifact?: boolean } = {}): Promise<Seen> {
  const seen: Seen = { testnet: 0, mainnet: 0, other: [] };
  await page.route(
    (url) => url.origin !== new URL(site.url).origin,
    async (route) => {
      const req = route.request();
      const host = new URL(req.url()).host;
      if (MAINNET_HOSTS.includes(host)) {
        seen.mainnet++;
        return route.abort();
      }
      if (!TESTNET_HOSTS.includes(host)) {
        seen.other.push(req.url());
        return route.abort();
      }
      if (req.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
      }
      seen.testnet++;
      const body = req.postData() ?? "";
      const rpc = JSON.parse(body);
      const type = rpc.params?.request_type;
      if (opts.testArtifact && (type === "view_code" || type === "view_account")) {
        const result =
          type === "view_code" ? { code_base64: CODE.toString("base64") } : { code_hash: CODE_HASH };
        return route.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, result }, headers: CORS });
      }
      const res = await fetch(replay.url(variant), { method: "POST", body });
      return route.fulfill({
        status: res.status,
        body: await res.text(),
        headers: { ...CORS, "content-type": "application/json" },
      });
    },
  );
  if (opts.testArtifact) {
    const testnet = manifest.networks.testnet;
    const artifact = {
      ...testnet.deployment.artifact,
      bytes: CODE.length,
      sha256: CODE_SHA256,
      nearCodeHash: CODE_HASH,
    };
    const changed = {
      ...manifest,
      networks: {
        ...manifest.networks,
        testnet: { ...testnet, deployment: { ...testnet.deployment, artifact } },
      },
    };
    await page.route("**/proof-manifest.json", (route) => route.fulfill({ json: changed }));
  }
  return seen;
}

const verdict = (page: Page) => page.locator("[data-verdict]");
const check = (page: Page, id: string) => page.locator(`tr[data-check="${id}"]`);
const RELEASE = "trd_197c633d724eeb2cddc64d6dabf55976";
const REFUND = "trd_a54930d5d5af718e0fc8a8c9d43b9a2d";

test("testnet tab: every check passes on the recorded chain answers", async ({ page }) => {
  const seen = await routeRpc(page, "recorded", { testArtifact: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(site.url);
  await expect(page.getByRole("tab", { name: "NEAR testnet" })).toHaveAttribute("aria-selected", "true");
  await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
  await expect(verdict(page)).toContainText("Pass: all 63 checks");
  await expect(verdict(page)).toContainText(/Read at final block \d+ .* with \d+ read-only requests/);
  await expect(page.locator('tr[data-status="PASS"]')).toHaveCount(63);
  await expect(page.locator('tr[data-status="FAIL"], tr[data-status="ERROR"]')).toHaveCount(0);

  // Deployment and config, with the expected value beside the value read.
  await expect(check(page, "code-bytes")).toContainText(`2048 bytes, sha256 ${CODE_SHA256}`);
  await expect(check(page, "config-min-deposit")).toContainText("1000000000000000000000 yoctoNEAR");
  await expect(check(page, "relayer-key")).toContainText("receiver gnanam1990-dock-escrow2.testnet");
  await expect(page.getByRole("link", { name: "gnanam1990-dock-escrow2.testnet" })).toHaveAttribute(
    "href",
    "https://testnet.nearblocks.io/address/gnanam1990-dock-escrow2.testnet",
  );

  // Each trade: ledger, conservation, transfers, and every transaction with its explorer link.
  await expect(page.locator("section[data-trade]")).toHaveCount(3);
  const release = page.locator(`section[data-trade="${RELEASE}"]`);
  await expect(release.locator("table.ledger tr.total")).toContainText("0.05");
  await expect(check(page, `${RELEASE}:conservation`)).toContainText(
    "funded 50000000000000000000000 = released 50000000000000000000000",
  );
  await expect(check(page, `${RELEASE}:transfers`)).toContainText(
    "0.05 NEAR to gnanam1990-dock-supplier.testnet",
  );
  await expect(check(page, `${REFUND}:refund-intents`)).toContainText("MUTUAL_CANCEL 0.05 NEAR REFUNDED");
  const txLinks = page.locator('tr[data-check^="tx:"] a');
  await expect(txLinks).toHaveCount(26);
  const first = manifest.networks.testnet.journeys[0].transactions[0].txHash;
  await expect(check(page, `tx:${first}`).locator("a")).toHaveAttribute(
    "href",
    `https://testnet.nearblocks.io/txns/${first}`,
  );
  await expect(check(page, "deploy-tx").getByRole("link", { name: "Open in explorer" })).toHaveAttribute(
    "href",
    `https://testnet.nearblocks.io/txns/${manifest.networks.testnet.deployment.deployTx.hash}`,
  );

  expect(seen.testnet).toBeGreaterThan(40);
  expect(seen.mainnet).toBe(0);
  expect(seen.other).toEqual([]);
  expect(errors).toEqual([]);
});

test("testnet tab: a value that cannot be read is shown as not readable and the verdict is not a pass", async ({
  page,
}) => {
  // The committed manifest; the recording has no contract download.
  await routeRpc(page, "recorded");
  await page.goto(site.url);
  await expect(verdict(page)).toHaveAttribute("data-verdict", "FAIL");
  await expect(verdict(page)).toContainText("Fail: 1 of 63 checks did not pass");
  await expect(verdict(page)).toContainText("1 value(s) could not be read");
  await expect(check(page, "code-bytes")).toHaveAttribute("data-status", "ERROR");
  await expect(check(page, "code-bytes")).toContainText("Not readable");
  await expect(check(page, "code-hash")).toHaveAttribute("data-status", "PASS");
  await expect(check(page, "code-hash")).toContainText("7GEti5E6NWcjq8kHj5Gweed5HwggY1cxPD7cfbB65h8N");
  await expect(page.locator('tr[data-status="PASS"]')).toHaveCount(62);
});

test("testnet tab: a chain that disagrees with the manifest is a visible FAIL", async ({ page }) => {
  await routeRpc(page, "ledger", { testArtifact: true });
  await page.goto(site.url);
  await expect(verdict(page)).toHaveAttribute("data-verdict", "FAIL");
  await expect(verdict(page)).toContainText("Fail: 3 of 63 checks did not pass");
  const row = check(page, `${RELEASE}:conservation`);
  await expect(row).toHaveAttribute("data-status", "FAIL");
  await expect(row).toContainText("sum to 50000000000000000000001, funded 50000000000000000000000");
  await expect(row.locator(".badge")).toHaveText("Fail");
});

test("testnet tab: an unreachable RPC endpoint is a FAIL, and reading again recovers", async ({ page }) => {
  await routeRpc(page, "down");
  await page.goto(site.url);
  await expect(verdict(page)).toHaveAttribute("data-verdict", "FAIL");
  await expect(check(page, "block")).toContainText("could not be read");
  await page.unrouteAll({ behavior: "wait" });
  await routeRpc(page, "recorded", { testArtifact: true });
  // The manifest was loaded before the route changed; only the RPC answers differ now, so the
  // code rows compare the committed digest with the test artifact and fail, the rest passes.
  await page.getByRole("button", { name: "Read again" }).click();
  await expect(verdict(page)).toContainText("Fail: 2 of 63 checks did not pass");
  await expect(check(page, "config-network")).toHaveAttribute("data-status", "PASS");
});

test("mainnet tab: not deployed yet, and no request is sent", async ({ page }) => {
  const seen = await routeRpc(page, "recorded", { testArtifact: true });
  await page.goto(`${site.url}#mainnet`);
  const tab = page.getByRole("tab", { name: /NEAR mainnet/ });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(tab).toContainText("not deployed yet");
  await expect(verdict(page)).toHaveAttribute("data-verdict", "NOT_DEPLOYED");
  await expect(verdict(page)).toContainText("Not deployed yet");
  await expect(verdict(page)).toContainText("no claim is made for this network");
  await expect(page.locator("tr[data-check]")).toHaveCount(0);
  expect(seen.mainnet).toBe(0);
  expect(seen.testnet).toBe(0);

  // Keyboard: the arrow keys move between the tabs.
  await tab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "NEAR testnet" })).toHaveAttribute("aria-selected", "true");
  await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
  await page.keyboard.press("ArrowRight");
  await expect(verdict(page)).toHaveAttribute("data-verdict", "NOT_DEPLOYED");
  expect(seen.mainnet).toBe(0);
});

test("accessible and without page overflow at every width, light and dark", async ({ page }) => {
  await routeRpc(page, "recorded", { testArtifact: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      await page.goto(site.url);
      await expect(verdict(page)).toHaveAttribute("data-verdict", "PASS");
      await expectNoBodyOverflow(page, `proof testnet ${scheme} ${v.name}`);
      if (v.name === "375" || v.name === "1440")
        await expectAccessible(page, `proof testnet ${scheme} ${v.name}`);
    }
    await page.goto(`${site.url}#mainnet`);
    await expect(verdict(page)).toHaveAttribute("data-verdict", "NOT_DEPLOYED");
    await expectAccessible(page, `proof mainnet ${scheme}`);
  }
});
