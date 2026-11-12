/**
 * T-006 / T-037 UI half (M14): the trade revision that rebinds a rotated key, in the browser,
 * against the real API process and every trade module (scripts/local-stack) on a SIMULATED NEAR
 * chain.
 *
 * 1. While every bound key is current there is nothing to rebind. The buyer approver rotates its
 *    own device key; every tab says a new revision is required and links to the key-rebinding
 *    control (it no longer says the revision cannot be created).
 * 2. The rebinding plan names the role, the bound and the current key. A non-party sees the plan
 *    and no control. The buyer signs the successor with its NEW key; the supplier signer reviews
 *    the same digest in its own session and consents with the key the revision binds. The
 *    one-minute signed delay (a party key changes) is refused early and then waited out for real;
 *    activation is relayed and the revision is bound.
 * 3. The approved pre-submit intent is superseded; manifest, inspection and approval blockers are
 *    back; renewed evidence, attestation, inspection and an approval signed by the new buyer key
 *    pay the bound supplier through the worker.
 * API, service and contract refusals (old key, stranger key, revocation, non-party matrix) are
 * services/api/test/m14-key-rebinding.test.ts and contract t006_key_rebinding.rs.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  completeEvidence,
  createTrade,
  fund,
  inspectPass,
  lockAndApprove,
  type StackInfo,
  waitAttested,
} from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, eventually, openTab, type Person, pdf, signAction } from "./stack";

test.describe.configure({ mode: "serial" });

let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let info: StackInfo;
let tradeId = "";
let firstIntent = "";

async function signIn(page: Page, publicKey: string, principalId: string): Promise<void> {
  await page.goto("/sign-in");
  await waitForScreen(page);
  await page.getByLabel("Device key", { exact: true }).selectOption(publicKey);
  await page.getByLabel("Principal ID", { exact: true }).fill(principalId);
  await page.getByRole("button", { name: "Request sign-in challenge" }).click();
  await expect(page.getByTestId("challenge-review")).toContainText("LOGIN");
  await page.getByRole("button", { name: "Sign with this device key" }).click();
  await expect(page).toHaveURL(/\/organization$/);
  await expect(page.getByTestId("me-panel")).toContainText(principalId);
}

async function checkViewports(page: Page, tab: string, label: string): Promise<void> {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(page, tradeId, tab);
    await expectNoBodyOverflow(page, `${label} @${vp.name}`);
    await expectAccessible(page, `${label} @${vp.name}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test.beforeAll(async ({ browser }) => {
  info = await control<StackInfo>("/control/info");
  expect(info.destinationChangeDelayMs).toBe(60_000);
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Bea Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Rio Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sam Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Ida Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("setup: registered, funded, evidence attested, inspector PASS, buyer approved a pre-submit intent", async () => {
  test.setTimeout(240_000);
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "rebind-1", amountNear: "10" },
  );
  await fund(tradeId, info.accounts.buyer, 10n);
  await completeEvidence(supplier.page, inspector.page, tradeId);
  await inspectPass(inspector.page, tradeId);
  await lockAndApprove(buyer.page, tradeId, true);
  await openTab(buyer.page, tradeId, "release");
  await eventually(buyer.page, async () => expect(buyer.page.getByTestId("execute-release")).toBeVisible());
  const b = buyer.page;
  await openTab(b, tradeId, "agreement");
  const kr = b.getByTestId("key-rebinding");
  await expect(kr.getByTestId("rebinding-not-needed")).toContainText("no key-rebinding revision is needed");
  await expect(kr.getByTestId("action-rebind-consent")).toHaveCount(0);
  await expect(b.getByTestId("authority-revision")).toHaveCount(0);
});

test("T-006 UI: the buyer rotates its key; every tab requires a new revision and links to the rebinding control", async () => {
  const b = buyer.page;
  await b.goto("/organization/keys");
  await waitForScreen(b);
  const mine = b.getByTestId("my-keys");
  await expect(mine.getByTestId("rotation-impact")).toContainText(tradeId);
  await mine.getByRole("button", { name: "Prepare key rotation" }).click();
  const review = b.getByTestId("rotation-review");
  await expect(review).toContainText("KEY_ROTATION");
  await review.getByRole("button", { name: "Sign rotation with the new key" }).click();
  const done = b.getByTestId("rotation-done");
  await expect(done).toContainText("still bind the previous key");
  const newKey = (await done.locator("code.address__value").innerText()).trim();
  await signIn(b, newKey, buyer.principalId);

  for (const tab of ["overview", "evidence", "release"]) {
    await openTab(b, tradeId, tab);
    const callout = b.getByTestId("authority-revision");
    await expect(callout.locator('[data-role="buyer"]')).toContainText("Bound key rotated");
    await expect(callout).not.toContainText("not served by this API build");
    await expect(callout.getByTestId("authority-revision-link")).toContainText("key-rebinding revision");
  }
  await openTab(b, tradeId, "overview");
  await b.getByTestId("authority-revision-link").click();
  await expect(b).toHaveURL(new RegExp(`/trades/${tradeId}/agreement$`));
  await waitForScreen(b);
  const plan = b.getByTestId("rebinding-plan");
  const row = plan.locator('tr[data-role="buyer"]');
  await expect(row).toContainText("Bound key rotated");
  await expect(row).toContainText("v1");
  await expect(row).toContainText("v2");
  await expect(row).toContainText(newKey);
  await expect(row).toContainText("Rebound to v2 by this revision");
  await expect(b.getByTestId("rebind-invalidations")).toContainText("SUPERSEDED_PRE_SUBMIT");
  await checkViewports(b, "agreement", "rebinding plan");

  // The named inspector is no payout party: it sees the plan and gets no control.
  const i = inspector.page;
  await openTab(i, tradeId, "agreement");
  const ki = i.getByTestId("key-rebinding");
  await expect(ki.getByTestId("rebinding-plan")).toContainText("Buyer approver");
  await expect(ki.getByTestId("blocked-reason")).toContainText(
    "Only the trade's bound buyer approver or supplier signer",
  );
  await expect(ki.getByTestId("action-rebind-consent")).toHaveCount(0);
});

test("T-006 UI: the new buyer key and the bound supplier key sign one successor; the signed delay is enforced", async () => {
  test.setTimeout(240_000);
  const b = buyer.page;
  const s = supplier.page;
  await openTab(b, tradeId, "agreement");
  const start = b.getByTestId("action-rebind-consent");
  await expect(start).toContainText("Start key-rebinding revision");
  await start.getByRole("button", { name: "Prepare key-rebinding revision", exact: true }).click();
  const review = start.getByTestId("review-rebind-consent");
  await expect(review).toContainText("TRADE_REVISION");
  await expect(review).toContainText("Digest recomputed by this browser");
  // The review names the signer: this session's new key version.
  await expect(review).toContainText("key version 2");
  await review.getByRole("button", { name: "Sign my consent" }).click();
  await start
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(start.getByTestId("done-rebind-consent")).toBeVisible({ timeout: 30_000 });

  await openTab(s, tradeId, "agreement");
  const pending = s.getByTestId("rebinding-pending");
  await expect(pending).toHaveAttribute("data-status", "PROPOSED");
  await expect(pending.getByTestId("rebind-consent-buyer")).toHaveAttribute("data-consented", "yes");
  await expect(pending.getByTestId("rebind-consent-supplier")).toHaveAttribute("data-consented", "no");
  await expect(pending).toContainText("delay begins at the second consent");
  await expect(s.getByRole("button", { name: "Activate key-rebinding revision" })).toHaveCount(0);
  await checkViewports(s, "agreement", "rebinding proposed");
  await openTab(s, tradeId, "agreement");
  const consent = s.getByTestId("action-rebind-consent");
  await expect(consent).toContainText("Consent to the key-rebinding revision");
  await signAction(s, "rebind-consent", "Review the successor revision", "Sign my consent");

  await openTab(b, tradeId, "agreement");
  await expect(b.getByTestId("rebinding-pending")).toHaveAttribute("data-status", "CONSENTED");
  await expect(b.getByTestId("rebind-delay-until")).toContainText("UTC");
  await expect(b.getByTestId("rebind-delay-countdown")).toContainText("refuse activation before then");
  await checkViewports(b, "agreement", "rebinding consented");
  // Early activation: the confirmation names the superseded intent; the server refuses.
  await openTab(b, tradeId, "agreement");
  await b.getByRole("button", { name: "Activate key-rebinding revision" }).click();
  const dialog = b.getByRole("dialog", { name: "Activate key-rebinding revision" });
  await expect(dialog).toContainText("SUPERSEDED_PRE_SUBMIT");
  await expect(dialog).toContainText("Buyer approver");
  await expectAccessible(b, "rebinding activation confirmation");
  firstIntent = ((await dialog.textContent()) ?? "").match(/rli_[0-9a-f]{32}/)?.[0] ?? "";
  expect(firstIntent).toMatch(/^rli_/);
  await dialog.getByRole("button", { name: "Prepare activation" }).click();
  const activation = b.getByTestId("rebinding-activation");
  await expect(activation).toContainText("DELAY_NOT_ELAPSED");
  await expect(activation.getByTestId("relay-panel")).toHaveCount(0);

  // The signed one-minute delay elapses for real; the supplier activates and binds.
  await s.waitForTimeout(62_000);
  await openTab(s, tradeId, "agreement");
  await s.getByRole("button", { name: "Activate key-rebinding revision" }).click();
  await s
    .getByRole("dialog", { name: "Activate key-rebinding revision" })
    .getByRole("button", { name: "Prepare activation" })
    .click();
  const sAct = s.getByTestId("rebinding-activation");
  await sAct
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(sAct.getByTestId("rebinding-bound")).toContainText("Revision r2 binds the current keys");
});

test("T-006 UI: the rebound revision invalidated every release fact; renewed authority pays the bound supplier", async () => {
  test.setTimeout(240_000);
  const b = buyer.page;
  for (const tab of ["overview", "agreement", "evidence"]) {
    await openTab(b, tradeId, tab);
    await expect(b.getByTestId("authority-revision")).toHaveCount(0);
  }
  await openTab(b, tradeId, "agreement");
  await expect(b.getByTestId("agreement-facts")).toContainText("revision r2");
  await expect(b.getByTestId("agreement-facts")).toContainText(info.accounts.supplier);
  await expect(b.getByTestId("rebinding-history")).toContainText("Key rebinding activated");
  await expect(b.getByTestId("rebinding-history")).toContainText("Buyer approver");
  await expect(b.getByTestId("rebinding-not-needed")).toBeVisible();
  await openTab(b, tradeId, "release");
  for (const code of ["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "APPROVAL_MISSING"])
    await expect(b.getByTestId("blockers")).toContainText(code);
  await expect(b.getByTestId("execute-release")).toHaveCount(0);
  // The intent approved under r1 is superseded before submit; its successor is unapproved.
  await expect(b.locator("tr", { hasText: firstIntent })).toContainText("Superseded before submit");
  await openTab(b, tradeId, "timeline");
  for (const e of [
    "KEY_REBINDING_CONSENT_RECORDED",
    "KEY_REBINDING_ACTIVATION_PREPARED",
    "KEY_REBINDING_REVISION_BOUND",
  ])
    await expect(b.getByTestId("timeline-table")).toContainText(e);

  // Renewed authority under r2: new evidence revision, attestation, inspection, new-key approval.
  const s = supplier.page;
  await openTab(s, tradeId, "evidence");
  const invoice = s.getByTestId("slot-commercial-invoice");
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice-r2.pdf",
    mimeType: "application/pdf",
    buffer: pdf(`Invoice for ${tradeId} under the rebound revision`),
  });
  await invoice.getByRole("button", { name: "Replace item in commercial-invoice" }).click();
  await expect(invoice.getByTestId("upload-commercial-invoice-status")).toContainText(
    "manifest is now revision",
  );
  await waitAttested(inspector.page, tradeId);
  await inspectPass(inspector.page, tradeId);
  await lockAndApprove(b, tradeId, false);
  await openTab(b, tradeId, "release");
  await eventually(b, async () => expect(b.getByTestId("execute-release")).toBeVisible());
  await b.getByRole("button", { name: "Execute direct release" }).click();
  const dialog = b.getByRole("dialog", { name: "Execute direct release" });
  await expect(dialog).toContainText(info.accounts.supplier);
  await dialog.getByRole("button", { name: "Queue release" }).click();
  await openTab(b, tradeId, "payout");
  await eventually(
    b,
    async () => expect(b.getByTestId("operation").first()).toHaveAttribute("data-state", "PAID"),
    90_000,
  );
  await waitForScreen(b);
  await expectAccessible(b, "payout after key rebinding");
});
