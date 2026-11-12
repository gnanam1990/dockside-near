/**
 * Helpers for the product browser tests. The control port belongs to the local stack's
 * organisation administrators, funder wallets and chain fault switches (scripts/local-stack);
 * every product action below is driven through the web UI in the actor's own browser context,
 * with its own non-extractable device key and PoP session.
 */
import { deflateSync } from "node:zlib";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { waitForScreen } from "./helpers";

/** Recovery delay the browser-test stack runs with (playwright.config.ts), so tests can watch it elapse. */
export const RECOVERY_DELAY_MS = 20_000;

/** Key-recovery challenge lifetime of the browser-test stack (M14), so an expired one can be re-issued. */
export const RECOVERY_CHALLENGE_TTL_MS = 25_000;

/** Read at call time: a second Playwright config (the asset-recovery stack) sets another port. */
const controlUrl = () => `http://127.0.0.1:${Number(process.env["DOCKSIDE_E2E_CONTROL_PORT"] ?? 8792)}`;

export async function control<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(controlUrl() + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json()) as T;
  if (!r.ok) throw new Error(`control ${path}: ${JSON.stringify(j)}`);
  return j;
}

export interface Person {
  readonly ctx: BrowserContext;
  readonly page: Page;
  readonly principalId: string;
}

/**
 * The organisation administrator invites; the person accepts in a fresh browser context (own
 * device key, own session) through the sign-in screen; the administrator grants afterwards.
 */
export async function enroll(
  browser: Browser,
  org: "buyer" | "supplier" | "inspector",
  capability: string,
  name: string,
): Promise<Person> {
  const inv = await control<{ invitationId: string; secret: string }>("/control/invitations", {
    org,
    capability,
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await waitForScreen(page);
  await page.getByLabel("Invitation secret").fill(inv.secret);
  await page.getByLabel("Your display name (optional)").fill(name);
  await page.getByRole("button", { name: "Request invitation challenge" }).click();
  await expect(page.getByTestId("challenge-review")).toContainText("INVITATION_ACCEPT");
  await page.getByRole("button", { name: "Sign with this device key" }).click();
  await expect(page.getByTestId("me-panel")).toContainText("Pending grant");
  await control("/control/grants", { org, invitationId: inv.invitationId });
  await page.reload();
  await waitForScreen(page);
  const panel = page.getByTestId("me-panel");
  await expect(panel).not.toContainText("Pending grant");
  const principalId = (
    await panel
      .locator("dt", { hasText: /^Principal$/ })
      .locator("xpath=following-sibling::dd")
      .innerText()
  ).trim();
  expect(principalId).toMatch(/^prn_[0-9a-f]{32}$/);
  return { ctx, page, principalId };
}

/* ------------------------------ evidence content ------------------------------ */

export function pdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 12 Tf 72 712 Td (${text}) Tj ET
endstream endobj

%%EOF
`);
}

function crc32(b: Uint8Array): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A real grayscale PNG. */
export function png(width: number, height: number, seed = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height).map((_, i) => (i * 7 + seed) & 0xff);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/* ---------------------------------- UI steps ---------------------------------- */

export async function openTab(page: Page, tradeId: string, tab: string): Promise<void> {
  await page.goto(`/trades/${tradeId}/${tab}`);
  await waitForScreen(page);
}

/** Prepare → review (browser-recomputed digest) → sign → relay through the configured relayer. */
export async function signAction(
  page: Page,
  id: string,
  startLabel: string,
  signLabel: string,
  opts: { relay?: boolean } = {},
): Promise<void> {
  const box = page.getByTestId(`action-${id}`);
  await box.getByRole("button", { name: startLabel, exact: true }).click();
  const review = box.getByTestId(`review-${id}`);
  await expect(review).toBeVisible();
  await expect(review).toContainText("Digest recomputed by this browser");
  await review.getByRole("button", { name: signLabel }).click();
  if (opts.relay !== false) {
    const relay = box.getByTestId("relay-panel");
    await expect(relay).toBeVisible();
    await relay.getByRole("button", { name: "Submit to the escrow contract" }).click();
  }
  await expect(box.getByTestId(`done-${id}`)).toBeVisible({ timeout: 30_000 });
}

/** Wait (with the page's own periodic refresh) until a locator matches. */
export async function eventually(page: Page, check: () => Promise<void>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      await check();
      return;
    } catch (e) {
      last = e;
      await page.waitForTimeout(1000);
    }
  }
  throw last;
}
