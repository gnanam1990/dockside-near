/**
 * T-037 STALE slot in the UI (M14), against the real API process and every trade module on its own
 * local stack with a SIMULATED NEAR chain (playwright.clock.config.ts).
 *
 * A complete, attested, inspected trade with an approved intent is ready for release. The test then
 * moves the stack's simulated trade clock and chain clock forward together (`/control/clock`, one
 * week and two minutes): nothing in the database or the page is edited. The inspection report
 * passes its seven-day freshness rule as the evidence service and the contract both compute it:
 *   - the slot shows STALE with its exact freshness deadline and recovery action, the other slots
 *     stay filled, completeness is not COMPLETE and the attestation is no longer current;
 *   - the release blockers come back and the release control is gone;
 *   - a replacement issued now by the browser's wall clock is itself older than the simulated
 *     freshness deadline, so the server refuses it (STALE_ITEM) and the slot stays STALE.
 * The authority, sessions and request proofs keep the wall clock; only the stack can move time.
 */
import { expect, test } from "@playwright/test";
import { completeEvidence, createTrade, fund, inspectPass, lockAndApprove, type StackInfo } from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, eventually, openTab, type Person } from "./stack";

test.describe.configure({ mode: "serial" });

const DAY = 24 * 3600_000;
let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let info: StackInfo;
let tradeId = "";

test.beforeAll(async ({ browser }) => {
  info = await control<StackInfo>("/control/info");
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Sia Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Ray Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sid Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Isa Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("setup: complete, attested, inspected and approved: release is ready", async () => {
  test.setTimeout(240_000);
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "stale-1", amountNear: "10" },
  );
  await fund(tradeId, info.accounts.buyer, 10n);
  await completeEvidence(supplier.page, inspector.page, tradeId);
  await inspectPass(inspector.page, tradeId);
  await lockAndApprove(buyer.page, tradeId, true);
  const b = buyer.page;
  await openTab(b, tradeId, "release");
  await eventually(b, async () => expect(b.getByTestId("execute-release")).toBeVisible());
  await openTab(b, tradeId, "evidence");
  await expect(b.getByTestId("slot-inspection-report")).toHaveAttribute("data-status", "FILLED");
  await expect(b.getByTestId("attestation-panel")).toContainText("Attestation current");
});

test("T-037 UI: simulated time passes the freshness rule; the slot is STALE and never looks complete", async () => {
  test.setTimeout(180_000);
  const moved = await control<{ tradeOffsetMs: number; chainOffsetMs: number }>("/control/clock", {
    advanceMs: 7 * DAY + 2 * 60_000,
  });
  expect(moved.tradeOffsetMs).toBe(7 * DAY + 2 * 60_000);
  const b = buyer.page;
  await openTab(b, tradeId, "evidence");
  const report = b.getByTestId("slot-inspection-report");
  await expect(report).toHaveAttribute("data-status", "STALE");
  await expect(report.locator('[data-dimension="slotStatus"]')).toHaveAttribute("data-value", "STALE");
  await expect(report).toContainText("Stale");
  await expect(report).toContainText("7 days from issue");
  await expect(report).toContainText("current item fresh until");
  await expect(report).toContainText("Upload a replacement");
  for (const slot of ["commercial-invoice", "cargo-photos"])
    await expect(b.getByTestId(`slot-${slot}`)).toHaveAttribute("data-status", "FILLED");
  await expect(b.locator('[data-dimension="evidenceState"]').first()).not.toHaveAttribute(
    "data-value",
    "COMPLETE",
  );
  await expect(b.getByTestId("attestation-panel")).not.toContainText("Attestation current");
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "evidence");
    await expectNoBodyOverflow(b, `stale slot @${vp.name}`);
    await expectAccessible(b, `stale slot @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });

  // Release readiness follows: the server and the contract no longer see a usable manifest.
  await openTab(b, tradeId, "release");
  await expect(b.getByTestId("blockers")).toContainText("MANIFEST_NOT_CURRENT");
  // The approved intent's release control stays visible but blocked, naming the lapsed condition.
  const exec = b.getByTestId("execute-release");
  await expect(exec).toHaveAttribute("data-blocked", "yes");
  await expect(exec.getByRole("button", { name: "Execute direct release" })).toBeDisabled();
  await expect(exec.getByTestId("blocked-reason")).toContainText("MANIFEST_NOT_CURRENT");
  await expectAccessible(b, "release with a stale slot");
});

test("T-037 UI: a replacement issued by the wall clock is older than the simulated deadline and is refused", async () => {
  const i = inspector.page;
  await openTab(i, tradeId, "evidence");
  const report = i.getByTestId("slot-inspection-report");
  await expect(report).toHaveAttribute("data-status", "STALE");
  await report.getByLabel("File for inspection-report").setInputFiles({
    name: "report-again.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`Re-inspection report for ${tradeId}.\n`),
  });
  await report.getByRole("button", { name: "Replace item in inspection-report" }).click();
  await expect(report).toContainText("STALE_ITEM");
  await expect(report).toContainText("past its freshness deadline");
  await waitForScreen(i);
  await expectAccessible(i, "refused stale replacement");
  await openTab(i, tradeId, "evidence");
  await expect(i.getByTestId("slot-inspection-report")).toHaveAttribute("data-status", "STALE");
});
