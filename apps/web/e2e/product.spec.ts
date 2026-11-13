/**
 * M08 product path in the browser against the real API process and every trade module
 * (scripts/local-stack). The chain is SIMULATED (compiled escrow wasm on the M02 host behind
 * JSON-RPC); nothing here touches NEAR testnet.
 *
 * Buyer approver, supplier signer, named inspector and risk/policy resolver each accept an
 * invitation in their own browser context with their own non-extractable device key. The
 * ManifestAttestor and deterministic-policy services run in isolated signer processes inside the
 * stack. Requests are never intercepted; each assertion reads what the real backend served.
 *
 * T-036 (simulated-chain stand-in for the direct testnet release), T-054, T-037 and T-038
 * (backend-reachable states) — see docs/status/M08.md for what remains NOT_RUN.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, eventually, openTab, type Person, pdf, png, signAction } from "./stack";

test.describe.configure({ mode: "serial" });

const VERIFY_RECEIPT_CLI = fileURLToPath(
  new URL("../../../services/api/dist/cli/verify-receipt.js", import.meta.url),
);

let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let tradeId = "";
let info: {
  accounts: { buyer: string; supplier: string };
  evidencePolicy: { id: string };
};

const copyValue = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).locator("code.address__value").first().innerText()).trim();

test.beforeAll(async ({ browser }) => {
  info = await control("/control/info");
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Dana Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Riya Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sam Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Ines Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("T-036 buyer proposes, supplier countersigns in a separate session, contract registers the trade", async () => {
  const b = buyer.page;
  await b.goto("/trades/new");
  await waitForScreen(b);
  await b.getByLabel("Supplier signer principal ID").fill(supplier.principalId);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Amount (native testnet NEAR)").fill("10");
  await b.getByLabel("Milestone reference").fill("shipment-1");
  await b.getByLabel("Milestone", { exact: true }).fill("Container MSCU1234565 loaded and inspected");
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Supplier NEAR testnet account").fill(info.accounts.supplier);
  await expect(b.getByText("Acceptance binds payment to this destination")).toBeVisible();
  await b.getByLabel("Buyer funding NEAR testnet account").fill(info.accounts.buyer);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Named inspector principal ID").fill(inspector.principalId);
  await b.getByLabel("Risk/policy resolver principal ID").fill(risk.principalId);
  await b.getByLabel("Evidence policy ID").fill(info.evidencePolicy.id);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByRole("button", { name: "Request canonical agreement" }).click();
  const review = b.getByTestId("proposal-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText(info.accounts.supplier);
  await expect(review).toContainText("10000000000000000000000000");
  await expect(review).toContainText(inspector.principalId);
  await expectAccessible(b, "proposal review");
  await review.getByRole("button", { name: "Sign as buyer approver" }).click();
  const pkg = await copyValue(b, "proposal-package");
  tradeId = (JSON.parse(pkg) as { terms: { tradeId: string } }).terms.tradeId;

  // A forged package (buyer signature replaced) is visibly refused by the supplier's session.
  const s = supplier.page;
  await s.goto("/trades/countersign");
  await waitForScreen(s);
  const forged = JSON.parse(pkg) as { terms: unknown; buyerSignature: string };
  forged.buyerSignature = `ed25519:${"1".repeat(86)}`;
  await s.getByLabel("Proposal package from the buyer").fill(JSON.stringify(forged));
  await s.getByRole("button", { name: "Review proposal" }).click();
  await expect(s.getByTestId("buyer-signature-check")).toContainText("does NOT verify");
  await expect(s.getByRole("button", { name: "Sign as supplier signer and submit" })).toBeDisabled();

  await s.getByLabel("Proposal package from the buyer").fill(pkg);
  await s.getByRole("button", { name: "Review proposal" }).click();
  await expect(s.getByTestId("buyer-signature-check")).toContainText("verifies against the buyer key");
  await s.getByRole("button", { name: "Sign as supplier signer and submit" }).click();
  const submitted = s.getByTestId("trade-submitted");
  await submitted
    .getByTestId("relay-panel")
    .first()
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await submitted
    .getByTestId("relay-panel")
    .nth(1)
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(s.getByTestId("trade-registered")).toBeVisible();

  // Every party now sees the trade; the funder's wallet deposits the exact amount.
  await control("/control/fund", {
    tradeId,
    from: info.accounts.buyer,
    amountYocto: "10000000000000000000000000",
  });
  await b.goto("/trades");
  await waitForScreen(b);
  await expect(b.getByTestId("trades-table")).toContainText(tradeId);
  await openTab(b, tradeId, "overview");
  await expect(b.getByTestId("funding")).toContainText("Yes (contract ledger)");
  await expect(b.getByTestId("blockers")).toContainText("MANIFEST_NOT_CURRENT");
});

test("T-037 evidence slots show the exact predicate and recovery, refuse bad content and preserve work on conflict", async () => {
  const s = supplier.page;
  await openTab(s, tradeId, "evidence");
  const invoice = s.getByTestId("slot-commercial-invoice");
  await expect(invoice).toHaveAttribute("data-status", "MISSING");
  await expect(invoice).toContainText("Upload a current item from an allowed uploader");
  // Wrong content class for the slot: refused by the server, slot stays MISSING.
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: png(8, 8),
  });
  await invoice.getByRole("button", { name: "Upload to commercial-invoice" }).click();
  await expect(invoice).toContainText("UNSUPPORTED_CONTENT");
  // Over the slot byte ceiling: resource limit state.
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "huge.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(70_000, 0x61),
  });
  await invoice.getByRole("button", { name: "Upload to commercial-invoice" }).click();
  await expect(invoice.getByText("Resource limit exceeded")).toBeVisible();
  await expect(invoice).toHaveAttribute("data-status", "MISSING");
  // The supplier cannot issue an inspector slot.
  await expect(s.getByTestId("slot-inspection-report")).toContainText("Only a principal holding INSPECTOR");

  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice INV-1 <draft>.pdf",
    mimeType: "application/pdf",
    buffer: pdf("Commercial invoice INV-1 total 10 NEAR"),
  });
  await invoice.getByRole("button", { name: "Upload to commercial-invoice" }).click();
  await expect(invoice.getByTestId("upload-commercial-invoice-status")).toContainText(
    "manifest is now revision",
  );
  await eventually(s, async () =>
    expect(s.getByTestId("slot-commercial-invoice")).toHaveAttribute("data-status", "FILLED"),
  );

  // Concurrent replacement: the inspector's page keeps showing the old manifest revision while the
  // supplier replaces the invoice in another session.
  const i = inspector.page;
  await openTab(i, tradeId, "evidence");
  await i.evaluate(() => {
    const top = window.setInterval(() => {}, 1000);
    for (let x = 0; x <= top; x++) window.clearInterval(x);
  });
  const report = i.getByTestId("slot-inspection-report");
  await report.getByLabel("File for inspection-report").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Inspection report: 12 pallets, seals intact, grade A.\n"),
  });
  await openTab(s, tradeId, "evidence");
  const inv2 = s.getByTestId("slot-commercial-invoice");
  await inv2.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice-INV-1-rev2.pdf",
    mimeType: "application/pdf",
    buffer: pdf("Commercial invoice INV-1 revised total 10 NEAR"),
  });
  await inv2.getByRole("button", { name: "Replace item in commercial-invoice" }).click();
  await expect(inv2.getByTestId("upload-commercial-invoice-status")).toContainText(
    "manifest is now revision",
  );
  await report.getByRole("button", { name: "Upload to inspection-report" }).click();
  await expect(report.getByText("Manifest changed while you were uploading")).toBeVisible();
  // Work is preserved: the same file is still selected; a fresh explicit action uploads it.
  await eventually(i, async () => {
    await report.getByRole("button", { name: "Upload to inspection-report" }).click();
    await expect(report.getByTestId("upload-inspection-report-status")).toContainText(
      "manifest is now revision",
      {
        timeout: 5_000,
      },
    );
  });
  const photos = i.getByTestId("slot-cargo-photos");
  await photos
    .getByLabel("File for cargo-photos")
    .setInputFiles({ name: "cargo.png", mimeType: "image/png", buffer: png(32, 16) });
  await photos.getByRole("button", { name: "Upload to cargo-photos" }).click();
  await expect(photos.getByTestId("upload-cargo-photos-status")).toContainText("manifest is now revision");

  // The isolated attestor service signs the complete manifest; the panel shows it current.
  await eventually(i, async () => {
    await i.reload();
    await waitForScreen(i);
    await expect(i.getByTestId("attestation-panel")).toContainText("Attestation current");
  });
  for (const vp of VIEWPORTS) {
    await i.setViewportSize({ width: vp.width, height: vp.height });
    await waitForScreen(i);
    await expectNoBodyOverflow(i, `evidence @${vp.name}`);
    await expectAccessible(i, `evidence @${vp.name}`);
  }
  await i.setViewportSize({ width: 1280, height: 900 });
});

test("T-054 deterministic policy SETs, buyer requests, only the risk session signs RESOLVE; expired-unresolved keeps blocking", async () => {
  const i = inspector.page;
  await openTab(i, tradeId, "evidence");
  await i.getByTestId("inspector-workbench").getByLabel("REVIEW").check();
  await i.getByLabel("Reason code", { exact: true }).fill("SEAL_MISMATCH");
  await signAction(i, "inspect", "Prepare inspection", "Sign inspection");

  // The deterministic-policy service evaluates its rule and SETs a HoldRecord.
  const b = buyer.page;
  await openTab(b, tradeId, "evidence");
  await eventually(b, async () => {
    await expect(b.getByTestId("hold").first()).toHaveAttribute("data-status", "ACTIVE");
  });
  const hold = b.getByTestId("hold").first();
  await expect(hold).toContainText("Deterministic policy (rule inspection-review@1) — cannot resolve");
  // Buyer: request, never resolve.
  await expect(b.getByRole("button", { name: "Prepare resolution" })).toHaveCount(0);
  await expect(b.getByTestId("no-resolver-ui")).toBeVisible();
  await hold.getByLabel("Message to the risk/policy resolver").fill("Seal photos re-taken; please review.");
  await hold.getByRole("button", { name: "Request resolution" }).click();
  await expect(hold).toContainText("It does not authorize anything; the hold is still ACTIVE");
  await openTab(b, tradeId, "release");
  await expect(b.getByTestId("blockers")).toContainText("HOLD_ACTIVE");

  // Supplier and inspector sessions get no resolver UI either.
  for (const p of [supplier.page, inspector.page]) {
    await openTab(p, tradeId, "evidence");
    await expect(p.getByRole("button", { name: "Prepare resolution" })).toHaveCount(0);
  }

  // The separately authenticated risk/policy resolver signs the resolution.
  const r = risk.page;
  await openTab(r, tradeId, "evidence");
  const rh = r.getByTestId("hold").first();
  await expect(rh).toContainText("(non-authorizing)");
  await rh.getByLabel("Resolution").selectOption("RETRY_INSPECTION");
  const holdId = (await rh.locator("h4 code").innerText()).trim();
  await signAction(r, `resolve-${holdId}`, "Prepare resolution", "Sign resolution");
  await eventually(r, async () =>
    expect(r.getByTestId("hold").first()).toHaveAttribute("data-status", "RESOLVED"),
  );

  // Inspector decides again: PASS.
  await openTab(i, tradeId, "evidence");
  await i.getByTestId("inspector-workbench").getByLabel("PASS").check();
  await i.getByLabel("Reason code", { exact: true }).fill("DOCS_MATCH");
  await signAction(i, "inspect", "Prepare inspection", "Sign inspection");

  // Risk SETs a one-minute hold; after expiry it reads EXPIRED_UNRESOLVED and still blocks release.
  await openTab(r, tradeId, "evidence");
  await r.getByLabel("Hold lifetime (minutes)").fill("1");
  await signAction(r, "set-hold", "Prepare hold", "Sign hold");
  await openTab(b, tradeId, "evidence");
  await eventually(
    b,
    async () => {
      await expect(b.locator('[data-testid="hold"][data-status="EXPIRED_UNRESOLVED"]')).toHaveCount(1);
    },
    120_000,
  );
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, tradeId, "evidence");
    await expect(b.locator('[data-testid="hold"][data-status="EXPIRED_UNRESOLVED"]')).toContainText(
      "Hold expired, unresolved",
    );
    await expect(b.getByRole("button", { name: "Prepare resolution" })).toHaveCount(0);
    await expectNoBodyOverflow(b, `hold @${vp.name}`);
    await expectAccessible(b, `hold @${vp.name}`);
    await openTab(b, tradeId, "release");
    await expect(b.getByTestId("blockers")).toContainText("HOLD_ACTIVE");
    await expectNoBodyOverflow(b, `release under hold @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });
  await openTab(r, tradeId, "evidence");
  const expired = r.locator('[data-testid="hold"][data-status="EXPIRED_UNRESOLVED"]');
  const expiredId = (await expired.locator("h4 code").innerText()).trim();
  await expired.getByLabel("Resolution").selectOption("RELEASE_HOLD");
  await signAction(r, `resolve-${expiredId}`, "Prepare resolution", "Sign resolution");
});

test("T-036 buyer locks and approves; T-038 a lost outcome stays locked and never looks paid; then PAID", async () => {
  const b = buyer.page;
  await openTab(b, tradeId, "release");
  await eventually(b, async () => {
    await b.reload();
    await waitForScreen(b);
    await expect(b.getByTestId("blockers")).not.toContainText("HOLD_ACTIVE");
  });
  await signAction(b, "lock", "Prepare release intent", "Sign release intent");
  await eventually(b, async () => expect(b.getByTestId("action-approve")).toBeVisible());
  const approve = b.getByTestId("action-approve");
  await approve.getByRole("button", { name: "Prepare approval" }).click();
  const review = approve.getByTestId("review-approve");
  await expect(review).toContainText(info.accounts.supplier);
  await expect(review).toContainText("10 NEAR");
  await expect(review).toContainText("Opening this page approves nothing");
  await expectAccessible(b, "approval review");
  await review.getByRole("button", { name: "Sign approval" }).click();
  await approve
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(approve.getByTestId("done-approve")).toBeVisible();

  // Exits exist before submission and only for the parties.
  await expect(b.getByTestId("exit-flows")).toBeVisible();
  await openTab(inspector.page, tradeId, "release");
  await expect(inspector.page.getByTestId("exit-flows")).toHaveCount(0);

  // Chain status source goes dark and the first broadcast response is lost.
  await control("/control/faults", { statusDown: true, dropSendResponses: 1 });
  await openTab(b, tradeId, "release");
  await eventually(b, async () => expect(b.getByTestId("execute-release")).toBeVisible());
  await b.getByRole("button", { name: "Execute direct release" }).click();
  const dialog = b.getByRole("dialog", { name: "Execute direct release" });
  await expect(dialog).toContainText(info.accounts.supplier);
  await dialog.getByRole("button", { name: "Queue release" }).click();
  await expect(b.getByTestId("execute-status")).toContainText("is QUEUED");

  await openTab(b, tradeId, "payout");
  await eventually(b, async () => {
    const op = b.getByTestId("operation").first();
    const state = await op.getAttribute("data-state");
    expect(state).toBe("UNKNOWN");
    await expect(op.getByTestId("op-locked")).toBeVisible();
  });
  const locked = b.getByTestId("operation").first();
  test.info().annotations.push({
    type: "locked-state-observed",
    description: String(await locked.getAttribute("data-state")),
  });
  await expect(locked).not.toContainText("Paid (terminal evidence recorded)");
  await expect(locked).toContainText("Prohibited while");
  await expect(locked.getByRole("button", { name: "Request reconciliation" })).toHaveCount(0);
  await expect(b.getByTestId("payout-dry")).toContainText("No funds moved; not used for testnet release");
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await waitForScreen(b);
    await expectNoBodyOverflow(b, `locked payout @${vp.name}`);
    await expectAccessible(b, `locked payout @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });
  // UNKNOWN: the reconciler keeps reading on its own schedule; no operator request is offered yet.
  const r = risk.page;
  await openTab(r, tradeId, "payout");
  await eventually(r, async () => expect(r.getByTestId("op-own-schedule")).toBeVisible());
  await expect(r.getByRole("button", { name: "Request reconciliation" })).toHaveCount(0);
  await openTab(b, tradeId, "release");
  await expect(b.getByTestId("exit-flows")).toHaveCount(0);
  await expect(b.getByTestId("exits-closed")).toBeVisible();

  // The status source returns but the node withholds receipts: final transaction, missing
  // evidence, so the reconciler moves to REVIEW (never PAID, never FAILED).
  await control("/control/faults", { statusDown: false, hideAllReceipts: true });
  await openTab(r, tradeId, "payout");
  await eventually(
    r,
    async () => expect(r.getByTestId("operation").first()).toHaveAttribute("data-state", "REVIEW"),
    90_000,
  );
  const inReview = r.getByTestId("operation").first();
  await expect(inReview).toContainText("Locked for review");
  await expect(inReview).not.toContainText("Paid (terminal evidence recorded)");
  test.info().annotations.push({ type: "locked-state-observed", description: "REVIEW" });
  await expect(inReview.getByRole("button", { name: "Open adjudication" })).toBeVisible();
  for (const vp of VIEWPORTS) {
    await r.setViewportSize({ width: vp.width, height: vp.height });
    await waitForScreen(r);
    await expectNoBodyOverflow(r, `review payout @${vp.name}`);
    await expectAccessible(r, `review payout @${vp.name}`);
  }
  await r.setViewportSize({ width: 1280, height: 900 });

  // The risk resolver asks for reconciliation while the receipts are still withheld: the request
  // is accepted from REVIEW but cannot decide anything, so the operation stays locked. Requesting
  // only after the receipts return would race the reconciler, which also leaves REVIEW on its own
  // when new evidence arrives (seen on Linux, where its 2 s re-check won before the click).
  await inReview.getByRole("button", { name: "Request reconciliation" }).click();
  await expect(inReview.getByTestId("op-locked")).toContainText(
    "Reconciliation requested; operation is REVIEW.",
  );
  test.info().annotations.push({
    type: "reconciliation-request",
    description: (await inReview.getByTestId("op-locked").locator("[role=status]").innerText()).trim(),
  });
  await expect(inReview).not.toContainText("Paid (terminal evidence recorded)");
  // Receipts become readable again; the reconciler proves the receipt and records PAID.
  await control("/control/faults", { hideAllReceipts: false });
  await openTab(b, tradeId, "payout");
  await eventually(
    b,
    async () => {
      await expect(b.getByTestId("operation").first()).toHaveAttribute("data-state", "PAID");
    },
    90_000,
  );
  await expect(b.getByTestId("operation").first()).toContainText("Paid (terminal evidence recorded)");
  await openTab(b, tradeId, "overview");
  await expect(b.getByTestId("funding")).toContainText("Released");
  await openTab(b, tradeId, "timeline");
  await expect(b.getByTestId("timeline-table")).toContainText("RELEASE_EXECUTION_REQUESTED");
  await b.getByRole("button", { name: "Prepare export preview" }).click();
  await expect(b.getByTestId("export-preview")).toContainText("Checksum");
  await expect(b.getByTestId("export-preview")).toContainText("MASKED");
  await expectAccessible(b, "timeline and export");
});

test("M54 payment receipt: signed, re-checked in the browser, saved as PDF and accepted offline", async () => {
  const b = buyer.page;
  await openTab(b, tradeId, "payout");
  const panel = b.getByTestId("payment-receipt");
  await panel.getByRole("button", { name: "Prepare signed receipt" }).click();
  await expect(panel.getByTestId("payment-receipt-verdict")).toContainText(
    "Signature verified in this browser",
    {
      timeout: 30_000,
    },
  );
  await expect(panel).toContainText(
    "Holds: The PDF matches its digest and carries exactly this signed statement",
  );
  const open = panel.getByRole("link", { name: "Open the receipt page (checks NEAR)" });
  await expect(open).toHaveAttribute("href", new RegExp(`/receipt/${tradeId}[?]network=testnet&tx=`));
  await expectAccessible(b, "payment receipt (buyer)");
  const [dl] = await Promise.all([
    b.waitForEvent("download"),
    panel.getByRole("link", { name: "Save signed PDF" }).click(),
  ]);
  expect(dl.suggestedFilename()).toBe(`dockside-receipt-${tradeId}.pdf`);
  const dir = mkdtempSync(join(tmpdir(), "dockside-m54-e2e-"));
  const file = join(dir, "receipt.pdf");
  const keysFile = join(dir, "keys.json");
  await dl.saveAs(file);
  // The operator's published key list, saved from the signed audit export panel (M17).
  await openTab(b, tradeId, "timeline");
  const exportPanel = b.getByTestId("signed-export");
  await exportPanel.getByRole("button", { name: "Prepare signed export" }).click();
  await expect(exportPanel.getByTestId("signed-export-verdict")).toContainText("Signature verified", {
    timeout: 30_000,
  });
  const [keysDl] = await Promise.all([
    b.waitForEvent("download"),
    exportPanel.getByRole("link", { name: "Save export key list" }).click(),
  ]);
  await keysDl.saveAs(keysFile);
  // A tampered copy is refused.
  const tampered = join(dir, "tampered.pdf");
  writeFileSync(
    tampered,
    Buffer.from(readFileSync(file).toString("latin1").replace("(PAID)", "(PA1D)"), "latin1"),
  );
  const bad = spawnSync(process.execPath, [VERIFY_RECEIPT_CLI, tampered, "--trusted-keys", keysFile], {
    encoding: "utf8",
  });
  expect(bad.status).toBe(1);
  const ok = spawnSync(process.execPath, [VERIFY_RECEIPT_CLI, file, "--trusted-keys", keysFile], {
    encoding: "utf8",
  });
  expect(ok.status, ok.stdout + ok.stderr).toBe(0);
  expect(ok.stdout).toContain(`VERIFIED: payment receipt of trade ${tradeId}`);
  expect(readFileSync(file).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
});

test("T-034 client boundary: no session token, invitation secret or evidence bytes in DOM, storage or accessibility tree", async () => {
  for (const p of [buyer, supplier, inspector, risk]) {
    const page = p.page;
    await openTab(page, tradeId, "evidence");
    const leaks = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem("dockside.session.v1");
      const token = raw ? (JSON.parse(raw) as { grant: { sessionToken: string } }).grant.sessionToken : "";
      const html = document.documentElement.outerHTML;
      const local = JSON.stringify({ ...window.localStorage });
      return {
        tokenInDom: token !== "" && html.includes(token),
        tokenInLocal: token !== "" && local.includes(token),
        evidenceText: html.includes("seals intact") || html.includes("total 10 NEAR"),
        privateKeyField: /privateKey|PRIVATE KEY/.test(html),
      };
    });
    expect(leaks).toEqual({
      tokenInDom: false,
      tokenInLocal: false,
      evidenceText: false,
      privateKeyField: false,
    });
    const tree = await page.locator("body").ariaSnapshot();
    expect(tree).not.toContain("seals intact");
  }
});

test("T-040 every trade tab with live data fits, passes axe at every width, at 720 px (200% zoom approximation) and in dark mode", async () => {
  const b = buyer.page;
  const tabs = ["overview", "agreement", "evidence", "release", "payout", "refund", "timeline"];
  for (const vp of [...VIEWPORTS, { name: "720-zoom", width: 720, height: 450 }]) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    for (const tab of tabs) {
      await openTab(b, tradeId, tab);
      await expectNoBodyOverflow(b, `${tab} @${vp.name}`);
      await expectAccessible(b, `${tab} @${vp.name}`);
    }
  }
  await b.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await b.setViewportSize({ width: 1280, height: 900 });
  for (const tab of ["overview", "evidence", "payout"]) {
    await openTab(b, tradeId, tab);
    await expectAccessible(b, `dark ${tab}`);
  }
  await b.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
});
