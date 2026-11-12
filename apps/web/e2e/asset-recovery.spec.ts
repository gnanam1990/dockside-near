/**
 * M11 unexpected-asset recovery in the browser (REAL-PRODUCT-GATE items 9 and 11; T-051 and the
 * unexpected-asset half of T-008), against the real API, the asset-recovery journal and worker,
 * and the compiled escrow on a SIMULATED NEAR chain with a SIMULATED NEP-141 token
 * (scripts/local-stack). Runs on its own stack (playwright.assets.config.ts).
 *
 * - Tokens sent by mistake with ft_transfer_call and an NFT are recorded in a separate "Asset
 *   recovery review" panel, never in the native deposits or refund candidates; the NFT has no safe
 *   adapter and offers no action.
 * - A trade party prepares the claimed sender's request (transfer transaction verified); only the
 *   sender's own (simulated) wallet can submit it. The bound risk/policy resolver approves in its
 *   own session over a journaled read-only validation; the 72-hour challenge starts.
 * - An early execution is queued once and refused by the contract (NOT_SUBMITTED, no retry).
 * - A second record: the supplier challenges in its own session (back to review); a new request is
 *   then withdrawn by the sender's own revocation.
 * - The simulated chain clock passes the window; the buyer executes; the worker submits once and
 *   the exact observed amount reaches the proven sender (RECOVERED).
 */
import { expect, type Page, test } from "@playwright/test";
import { createTrade, fund, type StackInfo } from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS } from "./helpers";
import { control, enroll, eventually, openTab, type Person, signAction } from "./stack";

test.describe.configure({ mode: "serial" });

interface AssetStackInfo extends StackInfo {
  readonly accounts: StackInfo["accounts"] & { tokenSender: string; claimant: string; token: string };
}

let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let info: AssetStackInfo;
let tradeId = "";
let transferHash = "";

const asset = (page: Page, i: number) => page.getByTestId(`asset-${i}`);
const recordState = (page: Page, i: number) =>
  asset(page, i).locator('[data-dimension="assetRecord"]').first();
const lastRecovery = (page: Page, i: number) =>
  asset(page, i)
    .locator('[data-testid^="recovery-"]')
    .last()
    .locator('[data-dimension="assetRecovery"]')
    .first();

/** Reads the exact call shown for the sender's (or claimant's) wallet and submits it from that account. */
async function walletSubmits(page: Page, actionId: string, from: string): Promise<void> {
  const box = page.getByTestId(`action-${actionId}`);
  const panel = box.getByTestId("asset-wallet");
  await expect(panel).toContainText(from);
  await expect(box.getByRole("button", { name: "Submit to the escrow contract" })).toHaveCount(0);
  const call = JSON.parse((await panel.locator("code.address__value").innerText()).trim()) as Record<
    string,
    unknown
  >;
  const res = await control<{ outcome: string }>("/control/sender-call", { from, call });
  expect(res.outcome).toBe("FINAL_SUCCESS");
}

async function prepareRequest(page: Page, i: number, hash?: string): Promise<void> {
  await openTab(page, tradeId, "refund");
  const box = page.getByTestId(`action-asset-request-${i}`);
  if (hash) await box.getByLabel("Sender's transfer transaction hash (optional)").fill(hash);
  await box.getByRole("button", { name: "Prepare sender's request call" }).click();
  await expect(box.getByTestId(`prepared-asset-request-${i}`)).toBeVisible();
}

async function approve(i: number): Promise<void> {
  await openTab(risk.page, tradeId, "refund");
  await expect(recordState(risk.page, i)).toHaveAttribute("data-value", "RECOVERY_REQUESTED");
  const box = risk.page.getByTestId(`action-asset-approve-${i}`);
  await box.getByRole("button", { name: "Run read-only validation and prepare approval" }).click();
  const review = box.getByTestId(`review-asset-approve-${i}`);
  await expect(review).toBeVisible();
  await expect(review.getByTestId(`validation-${i}`)).toContainText("SAFE");
  await expect(review).toContainText("ASSET_RECOVERY_APPROVAL");
  await review.getByRole("button", { name: "Sign approval" }).click();
  await box.getByTestId("relay-panel").getByRole("button", { name: "Submit to the escrow contract" }).click();
  await expect(box.getByTestId(`done-asset-approve-${i}`)).toBeVisible({ timeout: 30_000 });
}

async function execute(page: Page, i: number): Promise<void> {
  const box = page.getByTestId(`action-asset-execute-${i}`);
  await box.getByRole("button", { name: "Execute recovery" }).click();
  const dialog = page.getByRole("dialog", { name: "Execute asset recovery" });
  await expect(dialog).toContainText(info.accounts.tokenSender);
  await expect(dialog).toContainText("no retry button");
  await dialog.getByRole("button", { name: "Queue recovery" }).click();
  await expect(box.getByTestId(`execute-status-asset-execute-${i}`)).toContainText("Operation aop_");
}

test.beforeAll(async ({ browser }) => {
  info = await control<AssetStackInfo>("/control/info");
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Bea Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Rex Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sid Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Iris Inspector");
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "assets-1", amountNear: "10" },
  );
  await fund(tradeId, info.accounts.buyer, 10n);
  // A token holder sends tokens to the escrow by mistake (ft_transfer_call), then an NFT arrives.
  transferHash = (
    await control<{ txHash: string; outcome: string }>("/control/token-transfer", { amount: "5000000" })
  ).txHash;
  await control("/control/nft-transfer", { tokenId: "bill-of-lading-7" });
  await control("/control/token-transfer", { amount: "2000000" });
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("gate 9/11 UI: unexpected assets have their own review panel; the sender requests, risk approves, an early execution is refused", async () => {
  test.setTimeout(180_000);
  const b = buyer.page;
  await openTab(b, tradeId, "refund");
  const panel = b.getByTestId("asset-recovery");
  await expect(panel).toBeVisible();
  // Never native NEAR: the token sender is not a funder and no refund candidate names it.
  await expect(b.getByTestId("funder-buckets")).not.toContainText(info.accounts.tokenSender);
  await expect(
    b.locator(`[data-testid="candidate"][data-funder="${info.accounts.tokenSender}"]`),
  ).toHaveCount(0);
  await expect(recordState(b, 0)).toHaveAttribute("data-value", "ASSET_RECOVERY_REVIEW");
  await expect(asset(b, 0)).toContainText("Claimed sender (not proven)");
  await expect(asset(b, 0)).toContainText("none: unexpected assets have no native-NEAR funder");
  await expect(recordState(b, 1)).toHaveAttribute("data-value", "UNRECOVERABLE_OR_REVIEW");
  await expect(b.getByTestId("no-adapter-1")).toBeVisible();
  await expect(asset(b, 1).getByRole("button")).toHaveCount(0);

  // A non-party-role session (inspector) sees the records and no recovery control.
  await openTab(inspector.page, tradeId, "refund");
  await expect(recordState(inspector.page, 0)).toHaveAttribute("data-value", "ASSET_RECOVERY_REVIEW");
  await expect(
    inspector.page.getByTestId("asset-recovery").getByRole("button", { name: /Prepare|Execute|Sign/ }),
  ).toHaveCount(0);

  // The buyer prepares the sender's request with the transfer transaction as evidence.
  await prepareRequest(b, 0, transferHash);
  await expect(b.getByTestId("prepared-asset-request-0")).toContainText("verified against the transaction");
  await walletSubmits(b, "asset-request-0", info.accounts.tokenSender);
  await openTab(b, tradeId, "refund");
  await expect(recordState(b, 0)).toHaveAttribute("data-value", "RECOVERY_REQUESTED");
  await expect(lastRecovery(b, 0)).toHaveAttribute("data-value", "REQUESTED");
  await expectAccessible(b, "refund tab: asset recovery requested");

  await approve(0);
  await openTab(b, tradeId, "refund");
  await expect(recordState(b, 0)).toHaveAttribute("data-value", "RECOVERY_CHALLENGE_PERIOD");
  await expect(asset(b, 0)).toContainText("Challenge deadline (contract clock)");

  // Execution before the contract's 72-hour deadline: queued once, refused by the contract.
  await execute(b, 0);
  await eventually(b, async () => {
    await openTab(b, tradeId, "refund");
    await expect(
      asset(b, 0).locator('[data-dimension="assetOperation"][data-value="NOT_SUBMITTED"]'),
    ).toBeVisible({ timeout: 2_000 });
  });
  await expect(asset(b, 0)).toContainText("CONTRACT_REFUSED:DELAY_NOT_ELAPSED");
  await expect(recordState(b, 0)).toHaveAttribute("data-value", "RECOVERY_CHALLENGE_PERIOD");
});

test("challenge and revocation: the supplier's signed challenge and the sender's own revocation return the asset to review", async () => {
  test.setTimeout(180_000);
  const s = supplier.page;
  await prepareRequest(s, 2);
  await walletSubmits(s, "asset-request-2", info.accounts.tokenSender);
  await approve(2);
  await openTab(s, tradeId, "refund");
  await expect(recordState(s, 2)).toHaveAttribute("data-value", "RECOVERY_CHALLENGE_PERIOD");
  const box = s.getByTestId("action-asset-challenge-2");
  await box.getByLabel("Challenge statement").fill("The supplier holds the delivery note for these tokens.");
  await signAction(s, "asset-challenge-2", "Prepare challenge", "Sign challenge");
  await openTab(s, tradeId, "refund");
  await expect(recordState(s, 2)).toHaveAttribute("data-value", "ASSET_RECOVERY_REVIEW");
  await expect(lastRecovery(s, 2)).toHaveAttribute("data-value", "CHALLENGED");
  await expect(s.getByTestId("challenge-2")).toContainText("supplier signer");
  await expectAccessible(s, "refund tab: asset recovery challenged");

  // A new request, then the claimed sender withdraws it from its own account.
  const b = buyer.page;
  await prepareRequest(b, 2);
  await walletSubmits(b, "asset-request-2", info.accounts.tokenSender);
  await openTab(b, tradeId, "refund");
  const rv = b.getByTestId("action-asset-revoke-2");
  await rv.getByRole("button", { name: "Prepare sender's revocation call" }).click();
  await walletSubmits(b, "asset-revoke-2", info.accounts.tokenSender);
  await openTab(b, tradeId, "refund");
  await expect(recordState(b, 2)).toHaveAttribute("data-value", "ASSET_RECOVERY_REVIEW");
  await expect(lastRecovery(b, 2)).toHaveAttribute("data-value", "REVOKED");
});

test("after the simulated chain passes 72 hours, the journaled execution returns the exact amount to the proven sender", async () => {
  test.setTimeout(240_000);
  const before = await control<{ balances: Record<string, string> }>("/control/token");
  // Simulated chain only: block time moves forward past the challenge deadline. Nothing below signs
  // a payload, so the API's wall clock and the chain clock need not agree.
  await control("/control/chain-time", { advanceMs: 73 * 3600_000 });
  const b = buyer.page;
  await openTab(b, tradeId, "refund");
  await execute(b, 0);
  await eventually(b, async () => {
    await openTab(b, tradeId, "refund");
    await expect(recordState(b, 0)).toHaveAttribute("data-value", "RECOVERED", { timeout: 2_000 });
  });
  await expect(lastRecovery(b, 0)).toHaveAttribute("data-value", "RECOVERED");
  await expect(
    asset(b, 0).locator('[data-dimension="assetOperation"][data-value="RECOVERED"]'),
  ).toBeVisible();
  await expect(asset(b, 0)).toContainText("CONTRACT_RECOVERED_TOKEN_MOVED");
  const after = await control<{ balances: Record<string, string> }>("/control/token");
  const sender = info.accounts.tokenSender;
  expect(BigInt(after.balances[sender] ?? "0") - BigInt(before.balances[sender] ?? "0")).toBe(5_000_000n);
  expect(after.balances["dockside-escrow.testnet"]).toBe("2000000");
  // The native deposit is untouched by the recovery.
  await expect(b.getByTestId("funder-buckets")).not.toContainText(sender);
  for (const v of VIEWPORTS) {
    await b.setViewportSize({ width: v.width, height: v.height });
    await openTab(b, tradeId, "refund");
    await expect(b.getByTestId("asset-recovery")).toBeVisible();
    await expectNoBodyOverflow(b, `refund tab with asset recovery at ${v.name}`);
  }
  await expectAccessible(b, "refund tab: asset recovered");
});
