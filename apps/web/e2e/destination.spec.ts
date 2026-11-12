/**
 * T-042 UI half (M10): the adversarial redirection path in the browser, against the real API
 * process and every trade module (scripts/local-stack) on a SIMULATED NEAR chain.
 *
 * 1. A non-party session has no destination control; a malformed or unchanged destination and an
 *    activation before the signed delay are visibly refused; one party's consent never activates.
 * 2. A legitimate change: the supplier signer proposes, the buyer approver reviews the same digest
 *    in a separate session and consents, the one-minute signed delay (the configurable minimum,
 *    bound into this trade's signed delayPolicy) is waited out for real, activation is relayed and
 *    the activated revision is bound. The approved pre-submit intent is superseded and the
 *    manifest, inspection and approval blockers are back.
 * 3. Renewed full authority (new evidence revision, attestation, inspector PASS, buyer approval)
 *    pays the new destination through the worker.
 * API, service and contract denials of forged signatures are services/api/test/m09-t042-redirection.
 */
import { expect, test } from "@playwright/test";
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

test.beforeAll(async ({ browser }) => {
  info = await control<StackInfo>("/control/info");
  expect(info.destinationChangeDelayMs).toBe(60_000);
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Dora Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Rui Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sol Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Ivo Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("setup: registered, funded, evidence attested, inspector PASS, buyer approved a pre-submit intent", async () => {
  test.setTimeout(240_000);
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "redirect-1", amountNear: "10" },
  );
  await fund(tradeId, info.accounts.buyer, 10n);
  await completeEvidence(supplier.page, inspector.page, tradeId);
  await inspectPass(inspector.page, tradeId);
  await lockAndApprove(buyer.page, tradeId, true);
  await openTab(buyer.page, tradeId, "release");
  await eventually(buyer.page, async () => expect(buyer.page.getByTestId("execute-release")).toBeVisible());
});

test("T-042 UI: non-party, malformed, unchanged and one-sided changes are visibly denied", async () => {
  // The inspector (not a payout party) sees the comparison but no control.
  const i = inspector.page;
  await openTab(i, tradeId, "agreement");
  const di = i.getByTestId("destination-change");
  await expect(di.getByTestId("destination-compare")).toContainText(info.accounts.supplier);
  await expect(di.getByTestId("blocked-reason")).toContainText(
    "Only the trade's bound buyer approver or supplier signer",
  );
  await expect(di.getByRole("button", { name: "Prepare destination revision" })).toHaveCount(0);

  // Malformed destination: refused in the browser, nothing prepared.
  const s = supplier.page;
  await openTab(s, tradeId, "agreement");
  const start = s.getByTestId("action-dest-start");
  await expect(di.getByTestId("no-proposal")).toContainText("there is no quick edit");
  await s.getByLabel("New payout destination (NEAR testnet account)").fill("Harbor Payouts");
  await start.getByRole("button", { name: "Prepare destination revision", exact: true }).click();
  await expect(start.getByTestId("state-refused")).toContainText("not a NEAR testnet account");
  // Unchanged destination: the server refuses to prepare a successor.
  await s.getByLabel("New payout destination (NEAR testnet account)").fill(info.accounts.supplier);
  await start.getByRole("button", { name: "Prepare destination revision", exact: true }).click();
  await expect(start.getByTestId("state-error")).toContainText(
    "successor destination equals the active destination",
  );

  // One party's consent: PROPOSED, the delay has not started, and nobody gets an activation control.
  await s.getByLabel("New payout destination (NEAR testnet account)").fill(info.accounts.supplierAlt);
  await signAction(s, "dest-start", "Prepare destination revision", "Sign my consent");
  const b = buyer.page;
  await openTab(b, tradeId, "agreement");
  const pending = b.getByTestId("destination-pending");
  await expect(pending).toHaveAttribute("data-status", "PROPOSED");
  await expect(pending.getByTestId("consent-supplier")).toHaveAttribute("data-consented", "yes");
  await expect(pending.getByTestId("consent-buyer")).toHaveAttribute("data-consented", "no");
  await expect(pending).toContainText("delay begins at the second consent");
  await expect(pending).toContainText(`${info.accounts.supplier} → ${info.accounts.supplierAlt}`);
  await expect(b.getByRole("button", { name: "Activate destination revision" })).toHaveCount(0);
  await openTab(s, tradeId, "agreement");
  await expect(s.getByRole("button", { name: "Activate destination revision" })).toHaveCount(0);
  await expect(s.getByTestId("action-dest-consent")).toHaveCount(0);
  await expect(b.getByTestId("destination-invalidations")).toContainText("SUPERSEDED_PRE_SUBMIT");
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "agreement");
    await expectNoBodyOverflow(b, `destination proposed @${vp.name}`);
    await expectAccessible(b, `destination proposed @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });

  // The buyer rejects it with a signed revocation; the bound destination never changed.
  await openTab(b, tradeId, "agreement");
  await expect(b.getByTestId("action-dest-revoke")).toContainText("Reject this destination revision");
  await signAction(b, "dest-revoke", "Prepare cancellation", "Sign cancellation");
  await openTab(b, tradeId, "agreement");
  await expect(b.getByTestId("no-proposal")).toBeVisible();
  await expect(b.getByTestId("destination-history")).toContainText("Destination revision cancelled");
  await openTab(b, tradeId, "release");
  await expect(b.getByTestId("execute-release")).toBeVisible();
});

test("T-042 UI: dual consent, the signed delay, activation supersedes every release fact", async () => {
  test.setTimeout(240_000);
  const s = supplier.page;
  const b = buyer.page;
  await openTab(s, tradeId, "agreement");
  await s.getByLabel("New payout destination (NEAR testnet account)").fill(info.accounts.supplierAlt);
  await signAction(s, "dest-start", "Prepare destination revision", "Sign my consent");

  // The buyer reviews the exact successor digest in its own session and consents.
  await openTab(b, tradeId, "agreement");
  const consent = b.getByTestId("action-dest-consent");
  await expect(consent).toContainText(info.accounts.supplierAlt);
  await consent.getByRole("button", { name: "Review the successor revision", exact: true }).click();
  const review = consent.getByTestId("review-dest-consent");
  await expect(review).toContainText("TRADE_REVISION");
  await expect(review).toContainText("Digest recomputed by this browser");
  await review.getByRole("button", { name: "Sign my consent" }).click();
  await consent
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(consent.getByTestId("done-dest-consent")).toBeVisible();

  await openTab(b, tradeId, "agreement");
  await expect(b.getByTestId("destination-pending")).toHaveAttribute("data-status", "CONSENTED");
  await expect(b.getByTestId("delay-until")).toContainText("UTC");
  await expect(b.getByTestId("delay-countdown")).toContainText("refuse activation before then");
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "agreement");
    await expectNoBodyOverflow(b, `destination consented @${vp.name}`);
    await expectAccessible(b, `destination consented @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });

  // Activation before the delay: the confirmation names the superseded intent; the API refuses.
  await openTab(b, tradeId, "agreement");
  await b.getByRole("button", { name: "Activate destination revision" }).click();
  const dialog = b.getByRole("dialog", { name: "Activate destination revision" });
  await expect(dialog).toContainText("SUPERSEDED_PRE_SUBMIT");
  await expect(dialog).toContainText(info.accounts.supplierAlt);
  await expectAccessible(b, "activation confirmation");
  await dialog.getByRole("button", { name: "Prepare activation" }).click();
  const activation = b.getByTestId("destination-activation");
  await expect(activation).toContainText("DELAY_NOT_ELAPSED");
  await expect(activation.getByTestId("relay-panel")).toHaveCount(0);

  // The signed one-minute delay elapses for real; then the supplier activates and binds.
  await s.waitForTimeout(62_000);
  await openTab(s, tradeId, "agreement");
  await s.getByRole("button", { name: "Activate destination revision" }).click();
  await s
    .getByRole("dialog", { name: "Activate destination revision" })
    .getByRole("button", { name: "Prepare activation" })
    .click();
  const sAct = s.getByTestId("destination-activation");
  await sAct
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(sAct.getByTestId("destination-bound")).toContainText("Revision r2 is bound");

  await openTab(b, tradeId, "agreement");
  await expect(b.getByTestId("agreement-facts")).toContainText("revision r2");
  await expect(b.getByTestId("agreement-facts")).toContainText(info.accounts.supplierAlt);
  await expect(b.getByTestId("destination-history")).toContainText("Destination revision activated");
  await openTab(b, tradeId, "release");
  for (const code of ["MANIFEST_NOT_CURRENT", "INSPECTION_NOT_PASS", "APPROVAL_MISSING"])
    await expect(b.getByTestId("blockers")).toContainText(code);
  await expect(b.getByTestId("execute-release")).toHaveCount(0);
  await openTab(b, tradeId, "timeline");
  for (const e of [
    "DESTINATION_CONSENT_RECORDED",
    "DESTINATION_ACTIVATION_PREPARED",
    "DESTINATION_REVISION_BOUND",
  ])
    await expect(b.getByTestId("timeline-table")).toContainText(e);
});

test("T-042 UI: renewed evidence, attestation, inspection and approval pay only the new destination", async () => {
  test.setTimeout(240_000);
  const s = supplier.page;
  await openTab(s, tradeId, "evidence");
  const invoice = s.getByTestId("slot-commercial-invoice");
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice-r2.pdf",
    mimeType: "application/pdf",
    buffer: pdf(`Invoice for ${tradeId} payable to the revised destination`),
  });
  await invoice.getByRole("button", { name: "Replace item in commercial-invoice" }).click();
  await expect(invoice.getByTestId("upload-commercial-invoice-status")).toContainText(
    "manifest is now revision",
  );
  await waitAttested(inspector.page, tradeId);
  await inspectPass(inspector.page, tradeId);
  const b = buyer.page;
  await lockAndApprove(b, tradeId, false);
  await openTab(b, tradeId, "release");
  await eventually(b, async () => expect(b.getByTestId("execute-release")).toBeVisible());
  await b.getByRole("button", { name: "Execute direct release" }).click();
  const dialog = b.getByRole("dialog", { name: "Execute direct release" });
  await expect(dialog).toContainText(info.accounts.supplierAlt);
  await expect(dialog).not.toContainText(info.accounts.supplier);
  await dialog.getByRole("button", { name: "Queue release" }).click();
  await openTab(b, tradeId, "payout");
  await eventually(
    b,
    async () => expect(b.getByTestId("operation").first()).toHaveAttribute("data-state", "PAID"),
    90_000,
  );
  await expect(b.getByTestId("payout-direct")).toContainText(info.accounts.supplierAlt);
  await waitForScreen(b);
  await expectAccessible(b, "payout after redirection");
});
