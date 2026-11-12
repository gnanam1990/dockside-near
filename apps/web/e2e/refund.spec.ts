/**
 * M10 refund controls in the browser (UI half of T-008, T-009 and T-010 on the reachable rows),
 * against the real API and every trade module (scripts/local-stack) on a SIMULATED NEAR chain.
 *
 * - Excess funding is QUARANTINED for its own funder. A trade party prepares the excess return,
 *   but only the funder's own (simulated) wallet can submit it; revocation, also by that wallet,
 *   restores QUARANTINED exactly.
 * - Mutual cancellation: the buyer approver signs, the supplier signer reviews the identical
 *   journaled payload in a separate session and cosigns, the contract refuses authorization before
 *   its 1-hour revocation period, the simulated chain clock moves past it (the API and worker keep
 *   the wall clock), the relay authorizes and the economic-operation journal refunds the original
 *   funder exactly.
 * - A non-party session sees the contract view but no refund control.
 * The chain clock control exists only on the simulated chain (scripts/local-stack). It is used
 * once, in the last test here: afterwards the chain runs ahead of the API clock, so payloads the
 * API issues with a one-hour lifetime would read as expired on the chain. Only the shell spec (no
 * trades) runs after this file.
 */
import { expect, type Page, test } from "@playwright/test";
import { createTrade, fund, NEAR, type StackInfo } from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, eventually, openTab, type Person, signAction } from "./stack";

test.describe.configure({ mode: "serial" });

let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let info: StackInfo;
let tradeId = "";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const bucket = (page: Page, funder: string, name: string) =>
  page.locator(`[data-testid="funder-buckets"] tr[data-funder="${funder}"] td[data-bucket="${name}"]`);
const candidate = (page: Page, funder: string, reason: string) =>
  page.locator(`[data-testid="candidate"][data-funder="${funder}"][data-reason="${reason}"]`);
const intent = (page: Page, reason: string) =>
  page.locator(`[data-testid="refund-intent"][data-reason="${reason}"]`).first();

/** Reads the exact call the page shows for the funder's wallet and submits it from that account. */
async function funderWalletSubmits(page: Page, scope: string, from: string): Promise<void> {
  const panel = page.getByTestId(scope).getByTestId("funder-wallet");
  await expect(panel).toContainText(from);
  await expect(
    page.getByTestId(scope).getByRole("button", { name: "Submit to the escrow contract" }),
  ).toHaveCount(0);
  const call = JSON.parse((await panel.locator("code.address__value").innerText()).trim()) as Record<
    string,
    unknown
  >;
  const res = await control<{ outcome: string }>("/control/funder-call", { from, call });
  expect(res.outcome).toBe("FINAL_SUCCESS");
}

test.beforeAll(async ({ browser }) => {
  info = await control<StackInfo>("/control/info");
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Bea Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Rex Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sid Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Iris Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("T-008 UI: excess is quarantined for its funder; only the funder's wallet returns it, revocation restores QUARANTINED", async () => {
  test.setTimeout(180_000);
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "refund-1", amountNear: "10" },
  );
  await fund(tradeId, info.accounts.buyer, 6n);
  await fund(tradeId, info.accounts.treasury, 6n);
  const b = buyer.page;
  await openTab(b, tradeId, "refund");
  await expect(bucket(b, info.accounts.treasury, "quarantined")).toHaveAttribute(
    "data-yocto",
    (2n * NEAR).toString(),
  );
  await expect(bucket(b, info.accounts.buyer, "available")).toHaveAttribute(
    "data-yocto",
    (6n * NEAR).toString(),
  );
  const policy = b.getByTestId("refund-policy");
  await expect(policy).toContainText("dockside-refund-v1");
  await expect(policy.locator("details")).toHaveCount(9);
  for (const r of ["BUYER_KEY_LOSS", "SUPPLIER_KEY_LOSS", "INSPECTOR_KEY_LOSS"])
    await expect(b.getByTestId(`policy-row-${r}`)).toContainText("recovery-first, no automatic refund");
  await expect(candidate(b, info.accounts.treasury, "EXCESS_FUNDING_RETURN")).toHaveAttribute(
    "data-blocked",
    "",
  );
  await expect(candidate(b, info.accounts.buyer, "EXCESS_FUNDING_RETURN")).toHaveAttribute(
    "data-blocked",
    "NOTHING_ELIGIBLE",
  );
  await expect(candidate(b, info.accounts.buyer, "TRADE_EXPIRY")).toHaveAttribute(
    "data-blocked",
    "NOT_ELIGIBLE",
  );
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "refund");
    await expectNoBodyOverflow(b, `refund eligibility @${vp.name}`);
    await expectAccessible(b, `refund eligibility @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });

  // The inspector reads the contract view but holds no refund role.
  const i = inspector.page;
  await openTab(i, tradeId, "refund");
  await expect(i.getByTestId("refund-candidates").getByTestId("blocked-reason")).toContainText(
    "Only the trade's bound buyer approver, supplier signer or risk/policy resolver",
  );
  await expect(i.getByRole("button", { name: /Prepare (refund request|funder return call)/ })).toHaveCount(0);

  // The buyer prepares the treasury's excess return; only the treasury's own wallet can send it.
  await openTab(b, tradeId, "refund");
  const id = `action-refund-excess-funding-return-${slug(info.accounts.treasury)}`;
  await b.getByTestId(id).getByRole("button", { name: "Prepare funder return call" }).click();
  await funderWalletSubmits(b, id, info.accounts.treasury);
  await openTab(b, tradeId, "refund");
  const ex = intent(b, "EXCESS_FUNDING_RETURN");
  await expect(ex).toHaveAttribute("data-state", "TIMELOCKED");
  await expect(ex).toContainText("QUARANTINED");
  await expect(ex.getByTestId("refund-deadline")).toContainText("UTC");
  await expect(bucket(b, info.accounts.treasury, "quarantined")).toHaveAttribute("data-yocto", "0");
  await expect(bucket(b, info.accounts.treasury, "refundLocked")).toHaveAttribute(
    "data-yocto",
    (2n * NEAR).toString(),
  );
  await expect(candidate(b, info.accounts.treasury, "EXCESS_FUNDING_RETURN")).not.toHaveAttribute(
    "data-blocked",
    "",
  );

  // Revocation: again the funder's own call; the slice returns to QUARANTINED exactly.
  const rid = slug((await ex.getAttribute("data-id")) ?? "");
  await ex.getByRole("button", { name: "Prepare funder revocation call" }).click();
  await funderWalletSubmits(b, `action-revoke-${rid}`, info.accounts.treasury);
  await openTab(b, tradeId, "refund");
  await expect(intent(b, "EXCESS_FUNDING_RETURN")).toHaveAttribute("data-state", "REVOKED");
  await expect(intent(b, "EXCESS_FUNDING_RETURN")).toContainText("Refund revoked before execution");
  await expect(bucket(b, info.accounts.treasury, "quarantined")).toHaveAttribute(
    "data-yocto",
    (2n * NEAR).toString(),
  );
  await expect(bucket(b, info.accounts.treasury, "refundLocked")).toHaveAttribute("data-yocto", "0");
});

test("T-009 UI: a disputed funder return pauses in REVIEW, stays locked and offers no authorization or execution", async () => {
  const b = buyer.page;
  await openTab(b, tradeId, "refund");
  const id = `action-refund-excess-funding-return-${slug(info.accounts.treasury)}`;
  await b.getByTestId(id).getByRole("button", { name: "Prepare funder return call" }).click();
  await funderWalletSubmits(b, id, info.accounts.treasury);
  await openTab(b, tradeId, "refund");
  const ex = b.locator(
    '[data-testid="refund-intent"][data-reason="EXCESS_FUNDING_RETURN"][data-state="TIMELOCKED"]',
  );
  await expect(ex).toHaveCount(1);
  const exId = (await ex.getAttribute("data-id")) ?? "";
  const rid = slug(exId);
  // The supplier has no challenge path on an excess return.
  await openTab(supplier.page, tradeId, "refund");
  await expect(supplier.page.getByTestId(`action-dispute-${rid}`)).toHaveCount(0);
  // The buyer disputes; only the statement's digest leaves the browser.
  const box = b.getByTestId(`action-dispute-${rid}`);
  await box.getByLabel("Dispute reason code").fill("AMOUNT_MISMATCH");
  await box.getByLabel("Dispute statement").fill("Deposit 2 was split by the bank; amount to be confirmed.");
  await signAction(b, `dispute-${rid}`, "Prepare dispute", "Sign dispute");
  await openTab(b, tradeId, "refund");
  const disputed = b.locator(`[data-testid="refund-intent"][data-id="${exId}"]`);
  await expect(disputed).toHaveAttribute("data-state", "REVIEW");
  await expect(disputed).toContainText("Refund locked for review");
  await expect(disputed.getByTestId("refund-locked")).toContainText("BUYER dispute paused it");
  await expect(disputed.getByRole("button", { name: "Prepare authorization" })).toHaveCount(0);
  await expect(disputed.getByRole("button", { name: "Execute refund" })).toHaveCount(0);
  await expect(bucket(b, info.accounts.treasury, "refundLocked")).toHaveAttribute(
    "data-yocto",
    (2n * NEAR).toString(),
  );
  const html = await b.content();
  expect(html).not.toContain("split by the bank");
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "refund");
    await expectNoBodyOverflow(b, `refund review @${vp.name}`);
    await expectAccessible(b, `refund review @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });
});

test("T-009/T-010 UI: mutual cancellation needs both signers and the contract clock, then refunds the original funder", async () => {
  test.setTimeout(240_000);
  const b = buyer.page;
  const s = supplier.page;
  await openTab(b, tradeId, "refund");
  await expect(candidate(b, info.accounts.buyer, "MUTUAL_CANCEL")).toContainText("AVAILABLE");
  // The supplier holds no initiator control for the buyer's slice yet only as a party; the buyer starts.
  await signAction(
    b,
    `refund-mutual-cancel-${slug(info.accounts.buyer)}`,
    "Prepare refund request",
    "Sign refund request",
  );
  await openTab(b, tradeId, "refund");
  const mc = intent(b, "MUTUAL_CANCEL");
  await expect(mc).toHaveAttribute("data-state", "REQUESTED");
  await expect(mc).toContainText("Buyer approver: Signed; supplier signer: Not signed");
  await expect(mc.getByRole("button", { name: "Review the exact request" })).toHaveCount(0);
  const rid = slug((await mc.getAttribute("data-id")) ?? "");
  // The contract moved the slice to refund-locked: no second request for it is offered.
  await expect(bucket(b, info.accounts.buyer, "refundLocked")).toHaveAttribute(
    "data-yocto",
    (6n * NEAR).toString(),
  );
  await expect(candidate(b, info.accounts.buyer, "MUTUAL_CANCEL")).toHaveAttribute(
    "data-blocked",
    "NOTHING_ELIGIBLE",
  );
  await expect(b.getByTestId(`action-refund-mutual-cancel-${slug(info.accounts.buyer)}`)).toHaveCount(0);

  // The supplier reviews the identical payload in its own session and cosigns.
  await openTab(s, tradeId, "refund");
  await signAction(s, `cosign-${rid}`, "Review the exact request", "Sign the identical request");
  await openTab(s, tradeId, "refund");
  const smc = intent(s, "MUTUAL_CANCEL");
  await expect(smc).toHaveAttribute("data-state", "TIMELOCKED");
  await expect(smc).toContainText("Buyer approver: Signed; supplier signer: Signed");
  await expect(smc.getByTestId("refund-deadline")).toContainText("UTC");

  // Before the 1-hour period the contract refuses authorization on its own clock.
  const auth = s.getByTestId(`action-authorize-${rid}`);
  await auth.getByRole("button", { name: "Prepare authorization" }).click();
  await auth
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(auth.getByTestId(`refusal-authorize-${rid}`)).toContainText("DELAY_NOT_ELAPSED");
  await openTab(s, tradeId, "refund");
  await expect(intent(s, "MUTUAL_CANCEL")).toHaveAttribute("data-state", "TIMELOCKED");
  for (const vp of VIEWPORTS) {
    await s.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(s, tradeId, "refund");
    await expectNoBodyOverflow(s, `refund timelocked @${vp.name}`);
    await expectAccessible(s, `refund timelocked @${vp.name}`);
  }
  await s.setViewportSize({ width: 1280, height: 900 });

  // Simulated chain time moves past the revocation period; the relay now authorizes.
  await control("/control/chain-time", { advanceMs: 61 * 60_000 });
  await openTab(s, tradeId, "refund");
  const auth2 = s.getByTestId(`action-authorize-${rid}`);
  await auth2.getByRole("button", { name: "Prepare authorization" }).click();
  await auth2
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(auth2.getByTestId("relay-status")).toContainText("Contract accepted");
  await openTab(b, tradeId, "refund");
  await expect(intent(b, "MUTUAL_CANCEL")).toHaveAttribute("data-state", "AUTHORIZED");
  await expect(intent(b, "MUTUAL_CANCEL").getByRole("button", { name: "Prepare revocation" })).toHaveCount(0);

  // Execution through the economic-operation journal; the worker returns the slice to its funder.
  await intent(b, "MUTUAL_CANCEL").getByRole("button", { name: "Execute refund" }).click();
  const dialog = b.getByRole("dialog", { name: "Execute refund" });
  await expect(dialog).toContainText(info.accounts.buyer);
  await expect(dialog).toContainText("6 NEAR");
  await dialog.getByRole("button", { name: "Queue refund" }).click();
  await expect(b.getByTestId(`execute-status-execute-${rid}`)).toContainText("is QUEUED");
  await eventually(
    b,
    async () => {
      await openTab(b, tradeId, "refund");
      await expect(intent(b, "MUTUAL_CANCEL")).toHaveAttribute("data-state", "REFUNDED", { timeout: 2_000 });
    },
    90_000,
  );
  await expect(intent(b, "MUTUAL_CANCEL")).toContainText("Refunded to the original funder");
  await expect(bucket(b, info.accounts.buyer, "refunded")).toHaveAttribute(
    "data-yocto",
    (6n * NEAR).toString(),
  );
  await expect(bucket(b, info.accounts.buyer, "available")).toHaveAttribute("data-yocto", "0");
  await expect(b.getByTestId("refund-operations").getByTestId("operation").first()).toHaveAttribute(
    "data-state",
    "REFUNDED",
  );
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "refund");
    await expectNoBodyOverflow(b, `refund refunded @${vp.name}`);
    await expectAccessible(b, `refund refunded @${vp.name}`);
  }
  await b.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await b.setViewportSize({ width: 1280, height: 900 });
  await openTab(b, tradeId, "refund");
  await expectAccessible(b, "dark refund");
  await b.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await openTab(b, tradeId, "timeline");
  for (const e of [
    "REFUND_REQUEST_PREPARED",
    "REFUND_REQUEST_SIGNED",
    "REFUND_COSIGNED",
    "REFUND_AUTHORIZATION_RELAYED",
    "REFUND_EXECUTION_REQUESTED",
    "REFUND_REVOCATION_PREPARED",
  ])
    await expect(b.getByTestId("timeline-table")).toContainText(e);
  await waitForScreen(b);
});
