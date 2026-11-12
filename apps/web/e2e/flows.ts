/**
 * Multi-step product flows shared by the destination-change and refund browser tests. Every step
 * is driven through the web UI in the actor's own browser context (own device key, own PoP
 * session) against the real API on the local stack; the control port is used only for what a
 * person outside Dockside does (administrator invitations and grants, a funder's wallet).
 */
import { expect, type Page } from "@playwright/test";
import { waitForScreen } from "./helpers";
import { control, eventually, openTab, type Person, pdf, png, signAction } from "./stack";

export const NEAR = 10n ** 24n;

export interface StackInfo {
  readonly accounts: { buyer: string; treasury: string; supplier: string; supplierAlt: string };
  readonly evidencePolicy: { id: string };
  readonly destinationChangeDelayMs: number;
}

const copyValue = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).locator("code.address__value").first().innerText()).trim();

/** Buyer proposes, supplier countersigns in its own session, both relay; returns the trade id. */
export async function createTrade(
  info: StackInfo,
  people: { buyer: Person; supplier: Person; inspector: Person; risk: Person },
  opts: { milestone: string; amountNear: string; expiresInDays?: string },
): Promise<string> {
  const b = people.buyer.page;
  await b.goto("/trades/new");
  await waitForScreen(b);
  await b.getByLabel("Supplier signer principal ID").fill(people.supplier.principalId);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Amount (native testnet NEAR)").fill(opts.amountNear);
  await b.getByLabel("Milestone reference").fill(opts.milestone);
  await b
    .getByLabel("Milestone", { exact: true })
    .fill(`Milestone ${opts.milestone} delivered and inspected`);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Supplier NEAR testnet account").fill(info.accounts.supplier);
  await b.getByLabel("Buyer funding NEAR testnet account").fill(info.accounts.buyer);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Named inspector principal ID").fill(people.inspector.principalId);
  await b.getByLabel("Risk/policy resolver principal ID").fill(people.risk.principalId);
  await b.getByLabel("Evidence policy ID").fill(info.evidencePolicy.id);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByRole("button", { name: "Request canonical agreement" }).click();
  const review = b.getByTestId("proposal-review");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Sign as buyer approver" }).click();
  const pkg = await copyValue(b, "proposal-package");
  const tradeId = (JSON.parse(pkg) as { terms: { tradeId: string } }).terms.tradeId;

  const s = people.supplier.page;
  await s.goto("/trades/countersign");
  await waitForScreen(s);
  await s.getByLabel("Proposal package from the buyer").fill(pkg);
  await s.getByRole("button", { name: "Review proposal" }).click();
  await expect(s.getByTestId("buyer-signature-check")).toContainText("verifies against the buyer key");
  await s.getByRole("button", { name: "Sign as supplier signer and submit" }).click();
  const submitted = s.getByTestId("trade-submitted");
  for (const i of [0, 1])
    await submitted
      .getByTestId("relay-panel")
      .nth(i)
      .getByRole("button", { name: "Submit to the escrow contract" })
      .click();
  await expect(s.getByTestId("trade-registered")).toBeVisible();
  return tradeId;
}

/** Supplier and inspector fill every slot; the isolated attestor makes the manifest current. */
export async function completeEvidence(supplier: Page, inspector: Page, tradeId: string): Promise<void> {
  await openTab(supplier, tradeId, "evidence");
  const invoice = supplier.getByTestId("slot-commercial-invoice");
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice.pdf",
    mimeType: "application/pdf",
    buffer: pdf(`Commercial invoice for ${tradeId}`),
  });
  await invoice.getByRole("button", { name: "Upload to commercial-invoice" }).click();
  await expect(invoice.getByTestId("upload-commercial-invoice-status")).toContainText(
    "manifest is now revision",
  );
  await openTab(inspector, tradeId, "evidence");
  const report = inspector.getByTestId("slot-inspection-report");
  await report.getByLabel("File for inspection-report").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`Inspection report for ${tradeId}: seals intact.\n`),
  });
  await report.getByRole("button", { name: "Upload to inspection-report" }).click();
  await expect(report.getByTestId("upload-inspection-report-status")).toContainText(
    "manifest is now revision",
  );
  const photos = inspector.getByTestId("slot-cargo-photos");
  await photos
    .getByLabel("File for cargo-photos")
    .setInputFiles({ name: "cargo.png", mimeType: "image/png", buffer: png(24, 12, 3) });
  await photos.getByRole("button", { name: "Upload to cargo-photos" }).click();
  await expect(photos.getByTestId("upload-cargo-photos-status")).toContainText("manifest is now revision");
  await waitAttested(inspector, tradeId);
}

export async function waitAttested(page: Page, tradeId: string): Promise<void> {
  await eventually(page, async () => {
    await openTab(page, tradeId, "evidence");
    await expect(page.getByTestId("attestation-panel")).toContainText("Attestation current", {
      timeout: 2_000,
    });
  });
}

export async function inspectPass(inspector: Page, tradeId: string): Promise<void> {
  await openTab(inspector, tradeId, "evidence");
  await inspector.getByTestId("inspector-workbench").getByLabel("PASS").check();
  await inspector.getByLabel("Reason code", { exact: true }).fill("DOCS_MATCH");
  await signAction(inspector, "inspect", "Prepare inspection", "Sign inspection");
}

/** Buyer approves the live intent (preparing and locking one first when none is live). */
export async function lockAndApprove(buyer: Page, tradeId: string, lock: boolean): Promise<void> {
  await openTab(buyer, tradeId, "release");
  if (lock) {
    await eventually(buyer, async () => {
      await buyer.reload();
      await waitForScreen(buyer);
      await expect(buyer.getByTestId("blockers")).not.toContainText("INSPECTION_NOT_PASS", {
        timeout: 2_000,
      });
    });
    await signAction(buyer, "lock", "Prepare release intent", "Sign release intent");
  }
  await eventually(buyer, async () => expect(buyer.getByTestId("action-approve")).toBeVisible());
  await signAction(buyer, "approve", "Prepare approval", "Sign approval");
}

/** The buyer's simulated wallet sends the deposit (predecessor = funder account). */
export async function fund(tradeId: string, from: string, near: bigint): Promise<void> {
  await control("/control/fund", { tradeId, from, amountYocto: (near * NEAR).toString() });
}
