/**
 * M08a shell: accessibility (axe, WCAG 2.2 AA tags), responsive fit, keyboard path,
 * reduced motion, dark mode, and real-backend behaviour of every route. The API and the
 * web build are real processes; the only interception is the explicit network-failure
 * and tampered-challenge cases, which simulate an attacker or outage, never data.
 */
import { expect, test } from "@playwright/test";
import {
  bootstrapOrganization,
  expectAccessible,
  expectNoBodyOverflow,
  VIEWPORTS,
  waitForScreen,
} from "./helpers";

const TRADE_ID = `trd_${"0123456789abcdef".repeat(2)}`;
const ROUTES = [
  "/sign-in",
  "/trades",
  "/trades/new",
  "/trades/countersign",
  `/trades/${TRADE_ID}/overview`,
  `/trades/${TRADE_ID}/evidence`,
  "/inspections",
  "/payouts",
  "/audit",
  "/organization",
  "/organization/keys",
  "/organization/services",
  "/recovery",
  "/no-such-page",
];

test.describe("signed out", () => {
  for (const vp of VIEWPORTS) {
    test(`every route is accessible and fits at ${vp.name} px`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const r of ROUTES) {
        await page.goto(r);
        await waitForScreen(page);
        await expectNoBodyOverflow(page, `${r} @${vp.name}`);
        await expectAccessible(page, `${r} @${vp.name}`);
      }
    });
  }

  test("data routes ask for sign-in instead of showing data", async ({ page }) => {
    for (const r of [
      "/trades",
      "/audit",
      "/organization",
      "/organization/keys",
      "/organization/services",
      "/payouts",
      "/inspections",
    ]) {
      await page.goto(r);
      await waitForScreen(page);
      await expect(page.getByTestId("state-signin")).toBeVisible();
      await expect(page.locator("table")).toHaveCount(0);
    }
  });
});

test.describe("signed in against the real API", () => {
  test("bootstrap, then every route is accessible and fits at every viewport", async ({ page }) => {
    await bootstrapOrganization(page, "Axe Check Traders");
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const r of ROUTES.filter((x) => x !== "/sign-in")) {
        await page.goto(r);
        await waitForScreen(page);
        await expectNoBodyOverflow(page, `${r} @${vp.name}`);
        await expectAccessible(page, `signed-in ${r} @${vp.name}`);
      }
    }
  });

  test("organization and audit render real API data; planned endpoints render the API's own answer", async ({
    page,
  }) => {
    const principal = await bootstrapOrganization(page, "Harbor Imports");
    await expect(page.getByTestId("me-panel")).toContainText("Org Security Admin");
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "CONNECTED");

    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit" }).click();
    await expect(page.getByTestId("audit-table")).toBeVisible();
    await expect(page.getByTestId("audit-table")).toContainText("ORG_BOOTSTRAPPED");
    await expect(page.getByTestId("audit-table")).toContainText(principal);
    await page.getByLabel("Action").selectOption("ORG_BOOTSTRAPPED");
    await expect(page.getByTestId("audit-count")).toContainText("hidden by filters");

    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Trades" }).click();
    // Trade modules are configured: an administrator with no trade sees the empty state, no rows.
    await expect(page.getByTestId("state-empty")).toContainText("No trades yet");
    await expect(page.locator("table")).toHaveCount(0);

    // An unknown trade id gets the same NOT_FOUND as a trade the session is not related to.
    await page.goto(`/trades/${TRADE_ID}/payout`);
    await expect(page.getByTestId("state-error")).toContainText("NOT_FOUND: trade not found");
    await page.goto("/payouts");
    await expect(page.getByText("Funded payouts are disabled by server configuration")).toBeVisible();
    await expect(page.getByText("NEAR testnet").first()).toBeVisible();
  });

  test("invitation is accepted in a separate session and granted later by the administrator", async ({
    page,
    browser,
  }) => {
    await bootstrapOrganization(page, "Grant Flow Co");
    await page.getByLabel("Capability", { exact: true }).selectOption("BUYER_APPROVER");
    await page.getByRole("button", { name: "Create invitation" }).click();
    const created = page.getByTestId("invitation-created");
    await expect(created).toBeVisible();
    const codes = created.locator("code.address__value");
    const secret = (await codes.first().innerText()).trim();
    const invitationId = (await created.locator("dd code").first().innerText()).trim();
    expect(invitationId).toMatch(/^inv_[0-9a-f]{32}$/);

    const other = await browser.newContext();
    const buyer = await other.newPage();
    await buyer.goto("/sign-in");
    await waitForScreen(buyer);
    await buyer.getByLabel("Invitation secret").fill(secret);
    await buyer.getByLabel("Your display name (optional)").fill("Dana Buyer");
    await buyer.getByRole("button", { name: "Request invitation challenge" }).click();
    await expect(buyer.getByTestId("challenge-review")).toContainText("INVITATION_ACCEPT");
    await expect(buyer.getByTestId("challenge-review")).toContainText("Buyer Approver");
    await buyer.getByRole("button", { name: "Sign with this device key" }).click();
    await expect(buyer.getByTestId("me-panel")).toContainText("Pending grant");
    await expect(buyer.getByTestId("me-panel")).toContainText("None granted yet");
    await expect(buyer.getByText("Administration is not available to your role")).toBeVisible();

    await page.getByLabel("Invitation ID").fill(invitationId);
    await page.getByRole("button", { name: "Review grant" }).click();
    const dialog = page.getByRole("dialog", { name: "Grant capability" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Grant capability" }).click();
    await expect(page.getByText("Capability granted")).toBeVisible();

    await buyer.reload();
    await expect(buyer.getByTestId("me-panel")).toContainText("Buyer Approver");
    // The buyer's own session cannot read the organization audit log.
    await buyer.goto("/audit");
    await expect(buyer.getByTestId("state-forbidden")).toBeVisible();
    await other.close();
  });

  test("a stored device key signs in again after sign-out", async ({ page }) => {
    const principal = await bootstrapOrganization(page, "Return Visit Co");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.goto("/sign-in");
    await waitForScreen(page);
    await expect(page.getByLabel("Principal ID")).toHaveValue(principal);
    await page.getByRole("button", { name: "Request sign-in challenge" }).click();
    await expect(page.getByTestId("challenge-review")).toContainText("LOGIN");
    await page.getByRole("button", { name: "Sign with this device key" }).click();
    await expect(page.getByTestId("me-panel")).toContainText(principal);
  });

  test("create trade validates on blur, focuses a linked error summary and keeps inputs on server refusal", async ({
    page,
  }) => {
    await bootstrapOrganization(page, "Draft Co");
    await page.goto("/trades/new");
    await waitForScreen(page);
    await page.getByRole("button", { name: "Continue" }).click();
    const summary = page.locator(".error-summary");
    await expect(summary).toBeFocused();
    await expect(summary.getByRole("link")).toHaveCount(1);
    await summary.getByRole("link").first().click();
    await expect(page.getByLabel("Supplier signer principal ID")).toBeFocused();

    const id = (p: string, n: string) => `${p}_${n.repeat(32)}`;
    await page.getByLabel("Supplier signer principal ID").fill("not-an-id");
    await page.getByLabel("Supplier signer principal ID").blur();
    await expect(page.locator("#trade-supplierSignerPrincipalId-error")).toContainText("must be a prefix_");
    await page.getByLabel("Supplier signer principal ID").fill(id("prn", "2"));
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Amount (native testnet NEAR)").fill("12.5");
    await page.getByLabel("Milestone reference").fill("ds-1");
    await page
      .getByLabel("Milestone", { exact: true })
      .fill("Container DS-1 delivered and inspected at port");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Supplier NEAR testnet account").fill("supplier-payouts.testnet");
    await expect(page.getByText("Acceptance binds payment to this destination")).toBeVisible();
    await page.getByLabel("Buyer funding NEAR testnet account").fill("draft-buyer.testnet");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Named inspector principal ID").fill(id("prn", "4"));
    await page.getByLabel("Risk/policy resolver principal ID").fill(id("prn", "6"));
    await page.getByLabel("Evidence policy ID").fill("commercial-docs");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Request canonical agreement" }).click();
    // The administrator holds no Buyer Approver capability: the server refuses, inputs stay.
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("Server refused the draft (FORBIDDEN)");
    await expect(page.locator(".form-layout")).toContainText("supplier-payouts.testnet");
    await expect(page.locator(".form-layout")).toContainText("12.5");
  });

  test("disconnected API freezes data, disables mutations, and reconnects", async ({ page }) => {
    await bootstrapOrganization(page, "Outage Co");
    await page.route(/\/(v1|readyz|healthz)/, (route) => route.abort("connectionrefused"));
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Audit" }).click();
    await expect(page.getByTestId("banner-disconnected")).toBeVisible();
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "DISCONNECTED");
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Organization" })
      .click();
    await expect(page.getByRole("button", { name: "Create invitation" })).toBeDisabled();
    await expect(page.getByTestId("blocked-reason").first()).toContainText("Disconnected");
    await page.unroute(/\/(v1|readyz|healthz)/);
    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "CONNECTED");
    await expect(page.getByRole("button", { name: "Create invitation" })).toBeEnabled();
  });

  test("a tampered challenge is refused before any signature", async ({ page }) => {
    await page.goto("/sign-in");
    await waitForScreen(page);
    await page.route("**/v1/bootstrap/challenges", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { digestHex: string };
      body.digestHex = "00".repeat(32);
      await route.fulfill({ response: res, json: body });
    });
    let completed = false;
    page.on("request", (r) => {
      if (r.url().endsWith("/v1/bootstrap/complete")) completed = true;
    });
    await page.getByLabel("Organization name").fill("Tamper Check");
    await page.getByRole("button", { name: "Request bootstrap challenge" }).click();
    await expect(page.getByTestId("state-refused")).toContainText("server digest does not match payload");
    await expect(page.getByTestId("challenge-review")).toHaveCount(0);
    expect(completed).toBe(false);
  });
});

test.describe("preferences and input modes", () => {
  test("skip link is the first tab stop and moves focus to main", async ({ page }) => {
    await page.goto("/trades");
    await waitForScreen(page);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("reduced motion removes transitions", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/sign-in");
    await waitForScreen(page);
    const d = await page
      .getByRole("button", { name: "Request bootstrap challenge" })
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(d.split(",").every((x) => x.trim() === "0s")).toBe(true);
  });

  test("dark colour scheme passes contrast and accessibility checks", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await bootstrapOrganization(page, "Night Shift Co");
    for (const r of ["/organization", "/audit", "/trades", "/payouts", "/sign-in"]) {
      await page.goto(r);
      await waitForScreen(page);
      await expectAccessible(page, `dark ${r}`);
    }
  });

  test("narrow 720 px viewport (1440 px at 200% zoom) keeps content operable without overflow", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 720, height: 450 });
    await bootstrapOrganization(page, "Zoom Check Co");
    for (const r of ["/organization", "/audit", "/trades/new", "/payouts"]) {
      await page.goto(r);
      await waitForScreen(page);
      await expectNoBodyOverflow(page, `zoom ${r}`);
      await expectAccessible(page, `zoom ${r}`);
    }
  });
});
