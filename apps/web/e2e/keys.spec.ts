/**
 * M12 key management in the browser against the real API process and every trade module
 * (scripts/local-stack). The chain is SIMULATED (compiled escrow wasm on the M02 host behind
 * JSON-RPC); nothing here touches NEAR testnet.
 *
 * The buyer organization is created in the browser: its security administrator bootstraps it
 * with a device key, invites and grants the buyer approver, risk/policy resolver and an auditor
 * from the Organization screens, and enrolls its own ManifestAttestor and deterministic-policy
 * services from the Service identities screen. The service keys live in isolated signer
 * processes run by the stack's custody stand-in (control port); the browser only sees public
 * keys and forwards the PoP challenge to custody and the signature back. Supplier and inspector
 * belong to the stack's other organizations. Requests are never intercepted.
 *
 * Covered (T-037 UI sub-cases NOT_RUN in M08, plus the M12 screens): wrong scope (attestor
 * enrolled for another EvidencePolicy revision), wrong attestor (covering enrollment the revision
 * does not bind), wrong key version (bound attestor rotated); human key rotation, delayed
 * recovery with early-completion refusal, veto, and revocation; every change shows its effect on
 * the in-flight trade and requires a new trade revision.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  bootstrapOrganization,
  expectAccessible,
  expectNoBodyOverflow,
  VIEWPORTS,
  waitForScreen,
} from "./helpers";
import { control, enroll, eventually, openTab, type Person, pdf, png, RECOVERY_DELAY_MS } from "./stack";

test.describe.configure({ mode: "serial" });

let adminCtxPage: Page;
let adminPrincipal = "";
let buyer: Person;
let risk: Person;
let auditor: Person;
let supplier: Person;
let inspector: Person;
let tradeId = "";
let info: {
  accounts: { buyer: string; supplier: string };
  evidencePolicy: { id: string; revision: number };
};
const extra: Person[] = [];

const principalOf = async (page: Page) =>
  (
    await page
      .getByTestId("me-panel")
      .locator("dt", { hasText: /^Principal$/ })
      .locator("xpath=following-sibling::dd")
      .innerText()
  ).trim();

/** The administrator invites in the browser; the person accepts in a fresh context; the administrator grants. */
async function inviteViaUi(browser: Browser, capability: string, name: string): Promise<Person> {
  const a = adminCtxPage;
  await a.goto("/organization");
  await waitForScreen(a);
  await a.getByLabel("Capability", { exact: true }).selectOption(capability);
  await a.getByRole("button", { name: "Create invitation" }).click();
  const created = a.getByTestId("invitation-created");
  await expect(created).toBeVisible();
  const secret = (await created.locator("code.address__value").first().innerText()).trim();
  const invitationId = (await created.locator("dd code").first().innerText()).trim();
  await created.getByRole("button", { name: /hide the secret/ }).click();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  await waitForScreen(page);
  await page.getByLabel("Invitation secret").fill(secret);
  await page.getByLabel("Your display name (optional)").fill(name);
  await page.getByRole("button", { name: "Request invitation challenge" }).click();
  await expect(page.getByTestId("challenge-review")).toContainText("INVITATION_ACCEPT");
  await page.getByRole("button", { name: "Sign with this device key" }).click();
  await expect(page.getByTestId("me-panel")).toContainText("Pending grant");

  await a.getByLabel("Invitation ID").fill(invitationId);
  await a.getByRole("button", { name: "Review grant" }).click();
  await a
    .getByRole("dialog", { name: "Grant capability" })
    .getByRole("button", { name: "Grant capability" })
    .click();
  await expect(a.getByText("Capability granted")).toBeVisible();
  await page.reload();
  await waitForScreen(page);
  await expect(page.getByTestId("me-panel")).not.toContainText("Pending grant");
  return { ctx, page, principalId: await principalOf(page) };
}

/** Custody operator: a new isolated key that may sign only this capability's purpose. */
async function custodyKey(serviceId: string, capability: string) {
  return control<{ publicKey: string; custody: { kind: string; reference: string } }>(
    "/control/custody/keys",
    {
      serviceId,
      capability,
    },
  );
}

/** Hand the browser-verified service challenge to custody and paste its signature back. */
async function proveWithCustody(page: Page, purpose: string): Promise<void> {
  const panel = page.getByTestId("service-proof");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(purpose);
  await expect(panel).toContainText("The browser never signs a service challenge");
  const raw = (await panel.locator("code.address__value").nth(2).innerText()).trim();
  const { challenge } = JSON.parse(raw) as { challenge: unknown };
  const { signature } = await control<{ signature: string }>("/control/custody/sign", { challenge });
  await panel.getByLabel("Signature returned by the custody").fill(signature);
  await panel.getByRole("button", { name: "Submit custody proof" }).click();
  await expect(page.getByTestId("service-proved")).toBeVisible();
}

async function enrollService(
  page: Page,
  serviceId: string,
  capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET",
  policyRevision: number,
): Promise<string> {
  const key = await custodyKey(serviceId, capability);
  const form = page.getByTestId("enroll-service");
  await form.getByLabel("Service ID", { exact: true }).fill(serviceId);
  await form.getByLabel("Service capability").selectOption(capability);
  await form.getByLabel("EvidencePolicy ID").fill(info.evidencePolicy.id);
  await form.getByLabel("EvidencePolicy revision").fill(String(policyRevision));
  await form.getByLabel("Service public key").fill(key.publicKey);
  await form.getByLabel("Custody kind").selectOption(key.custody.kind);
  await form.getByLabel("Custody locator (write-only)").fill(key.custody.reference);
  await form.getByRole("button", { name: "Review enrollment" }).click();
  const dialog = page.getByRole("dialog", { name: "Enroll service identity" });
  await expect(dialog).toContainText(serviceId);
  await dialog.getByRole("button", { name: "Enroll service" }).click();
  await proveWithCustody(page, "SERVICE_ENROLL");
  const card = page.getByTestId(`service-${serviceId}`);
  await card.getByRole("button", { name: "Activate v1" }).click();
  await page
    .getByRole("dialog", { name: `Activate ${serviceId} v1` })
    .getByRole("button", { name: "Activate v1" })
    .click();
  await expect(card.locator('[data-dimension="enrollmentStatus"]')).toHaveAttribute("data-value", "ACTIVE");
  // Secrets are write-only: the locator is never shown back.
  await expect(page.locator("body")).not.toContainText(key.custody.reference);
  return (await card.getAttribute("data-enrollment")) ?? "";
}

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

async function checkViewports(page: Page, label: string): Promise<void> {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await waitForScreen(page);
    await expectNoBodyOverflow(page, `${label} @${vp.name}`);
    await expectAccessible(page, `${label} @${vp.name}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const impactRow = (page: Page, role: string) =>
  page.getByTestId("trade-impact").locator(`tr[data-trade="${tradeId}"][data-role="${role}"]`);

test.beforeAll(async ({ browser }) => {
  info = await control("/control/info");
  const ctx = await browser.newContext();
  adminCtxPage = await ctx.newPage();
  adminPrincipal = await bootstrapOrganization(adminCtxPage, "Keyside Imports");
  buyer = await inviteViaUi(browser, "BUYER_APPROVER", "Bea Buyer");
  risk = await inviteViaUi(browser, "RISK_RESOLVER", "Rafa Risk");
  auditor = await inviteViaUi(browser, "AUDITOR", "Avi Auditor");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sol Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Ivo Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, risk, auditor, supplier, inspector, ...extra]) await p?.ctx.close();
  await adminCtxPage?.context().close();
});

test("M12 the administrator enrolls ManifestAttestor and policy services; custody proves; the locator stays write-only", async () => {
  const a = adminCtxPage;
  await a.goto("/organization/services");
  await waitForScreen(a);
  await expect(a.getByTestId("services")).toContainText("No service identity is enrolled");
  await enrollService(a, "keyside-attestor", "MANIFEST_ATTEST", info.evidencePolicy.revision);
  await enrollService(a, "keyside-policy", "DETERMINISTIC_POLICY_SET", info.evidencePolicy.revision);
  // An attestor enrolled for another EvidencePolicy revision (wrong scope for this policy's trades).
  await enrollService(a, "keyside-attestor-r2", "MANIFEST_ATTEST", info.evidencePolicy.revision + 1);

  // A non-administrator gets no service administration, and the server refuses the directory.
  const b = buyer.page;
  await b.goto("/organization/services");
  await waitForScreen(b);
  await expect(b.getByText("Service administration is not available to your role")).toBeVisible();
  await b.goto("/organization/keys");
  await waitForScreen(b);
  await expect(b.getByText("Organization key administration is not available to your role")).toBeVisible();
  await checkViewports(a, "services");
});

test("M12 buyer and supplier bind the organization's services in a trade; evidence is attested by the enrolled custody key", async () => {
  const b = buyer.page;
  await b.goto("/trades/new");
  await waitForScreen(b);
  await b.getByLabel("Supplier signer principal ID").fill(supplier.principalId);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Amount (native testnet NEAR)").fill("4");
  await b.getByLabel("Milestone reference").fill("keys-1");
  await b.getByLabel("Milestone", { exact: true }).fill("Pallets loaded for the key-management check");
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Supplier NEAR testnet account").fill(info.accounts.supplier);
  await b.getByLabel("Buyer funding NEAR testnet account").fill(info.accounts.buyer);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Named inspector principal ID").fill(inspector.principalId);
  await b.getByLabel("Risk/policy resolver principal ID").fill(risk.principalId);
  await b.getByLabel("Evidence policy ID").fill(info.evidencePolicy.id);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByRole("button", { name: "Request canonical agreement" }).click();
  const review = b.getByTestId("proposal-review");
  await expect(review).toContainText("keyside-attestor");
  await expect(review).not.toContainText("keyside-attestor-r2");
  await expect(review).toContainText("keyside-policy");
  await review.getByRole("button", { name: "Sign as buyer approver" }).click();
  const pkg = (
    await b.getByTestId("proposal-package").locator("code.address__value").first().innerText()
  ).trim();
  tradeId = (JSON.parse(pkg) as { terms: { tradeId: string } }).terms.tradeId;

  const s = supplier.page;
  await s.goto("/trades/countersign");
  await waitForScreen(s);
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

  await openTab(s, tradeId, "evidence");
  const invoice = s.getByTestId("slot-commercial-invoice");
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice-K1.pdf",
    mimeType: "application/pdf",
    buffer: pdf("Commercial invoice K1 total 4 NEAR"),
  });
  await invoice.getByRole("button", { name: "Upload to commercial-invoice" }).click();
  await expect(invoice.getByTestId("upload-commercial-invoice-status")).toContainText(
    "manifest is now revision",
  );
  const i = inspector.page;
  await openTab(i, tradeId, "evidence");
  const report = i.getByTestId("slot-inspection-report");
  await report.getByLabel("File for inspection-report").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Inspection report: 4 pallets, seals intact.\n"),
  });
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
    .setInputFiles({ name: "p.png", mimeType: "image/png", buffer: png(24, 12, 3) });
  await photos.getByRole("button", { name: "Upload to cargo-photos" }).click();
  await expect(photos.getByTestId("upload-cargo-photos-status")).toContainText("manifest is now revision");
  await eventually(b, async () => {
    await openTab(b, tradeId, "evidence");
    await expect(b.getByTestId("attestation-panel")).toContainText("Attestation current");
  });
  // Before any key change every bound role of the buyer organization is current.
  await adminCtxPage.goto("/organization/keys");
  await waitForScreen(adminCtxPage);
  for (const role of ["buyer", "riskResolver", "manifestAttestor", "policySetter"])
    await expect(impactRow(adminCtxPage, role)).toContainText("Current: the bound key is active");
  await expect(b.getByTestId("authority-revision")).toHaveCount(0);
});

test("T-037 wrong scope and wrong attestor are shown against the trade and never look bound", async () => {
  const a = adminCtxPage;
  await a.goto("/organization/services");
  await waitForScreen(a);
  // A second attestor for the same policy, enrolled after the trade: it covers but is not bound.
  await enrollService(a, "keyside-attestor-b", "MANIFEST_ATTEST", info.evidencePolicy.revision);

  const b = buyer.page;
  await openTab(b, tradeId, "evidence");
  const table = b.getByTestId("org-attestors");
  const row = (serviceId: string) => table.locator("tr", { hasText: serviceId });
  await expect(table.locator('tr[data-bound="yes"]')).toHaveCount(1);
  await expect(row("keyside-attestor-r2")).toHaveAttribute("data-coverage", "SCOPE_MISMATCH");
  await expect(row("keyside-attestor-r2")).toContainText("Wrong scope");
  await expect(row("keyside-attestor-r2")).toContainText("wrong attestor for this revision");
  await expect(row("keyside-attestor-b")).toHaveAttribute("data-coverage", "COVERS");
  await expect(row("keyside-attestor-b")).toHaveAttribute("data-bound", "no");
  await expect(row("keyside-attestor-b")).toContainText("wrong attestor for this revision");
  await expect(table.locator('tr[data-bound="yes"]')).toContainText("bound v1 is the active version");
  await expect(b.getByTestId("attestation-panel")).toContainText("Attestation current");
  // The supplier's organization sees none of the buyer organization's enrollments.
  await openTab(supplier.page, tradeId, "evidence");
  await expect(supplier.page.getByTestId("org-attestors-none")).toBeVisible();
});

test("T-037 rotating the bound attestor (wrong key version) invalidates the attestation and requires a new trade revision", async () => {
  const a = adminCtxPage;
  await a.goto("/organization/services");
  await waitForScreen(a);
  const card = a.getByTestId("service-keyside-attestor");
  const enrollmentId = (await card.getAttribute("data-enrollment")) ?? "";
  await card.getByRole("button", { name: "Rotate keyside-attestor key" }).click();
  const key = await custodyKey("keyside-attestor", "MANIFEST_ATTEST");
  const form = a.getByTestId(`rotate-form-${enrollmentId}`);
  await form.getByLabel("Service public key").fill(key.publicKey);
  await form.getByLabel("Custody locator (write-only)").fill(key.custody.reference);
  await form.getByRole("button", { name: "Review rotation" }).click();
  const dialog = a.getByRole("dialog", { name: "Rotate keyside-attestor" });
  await expect(dialog.getByTestId("affected-trades")).toContainText(tradeId);
  await dialog.getByRole("button", { name: "Create rotation version" }).click();
  await proveWithCustody(a, "SERVICE_ROTATE");
  await card.getByRole("button", { name: "Activate v2" }).click();
  const act = a.getByRole("dialog", { name: "Activate keyside-attestor v2" });
  await expect(act.getByTestId("affected-trades")).toContainText(tradeId);
  await act.getByRole("button", { name: "Activate v2" }).click();
  await expect(card.locator('tr[data-key-version="1"]')).toHaveAttribute("data-status", "SUPERSEDED");
  await expect(card.locator('tr[data-key-version="2"]')).toHaveAttribute("data-status", "ACTIVE");
  await expect(impactRow(a, "manifestAttestor")).toContainText("Bound key rotated");
  await expect(a.locator("body")).not.toContainText(key.custody.reference);

  const b = buyer.page;
  await openTab(b, tradeId, "evidence");
  const callout = b.getByTestId("authority-revision");
  await expect(callout).toContainText("A new trade revision is required");
  await expect(callout.locator('[data-role="manifestAttestor"]')).toContainText("Bound key rotated");
  await expect(b.getByTestId("attestation-panel")).not.toContainText("Attestation current");
  await expect(b.getByTestId("attestor-binding-issues")).toContainText("Bound key rotated");
  await expect(b.getByTestId("org-attestors").locator('tr[data-bound="yes"]')).toContainText(
    "wrong key version: revision binds v1, active is v2",
  );
  await b.goto("/trades");
  await waitForScreen(b);
  await expect(b.locator(`tr[data-trade="${tradeId}"]`).getByTestId("needs-new-revision")).toBeVisible();
  // Every other party sees the same requirement.
  await openTab(supplier.page, tradeId, "overview");
  await expect(supplier.page.getByTestId("authority-revision")).toContainText("ManifestAttestor");
  await openTab(b, tradeId, "evidence");
  await checkViewports(b, "evidence after attestor rotation");
  await a.goto("/organization/services");
  await checkViewports(a, "services after rotation");
});

test("M12 the buyer rotates its own key; the old session ends; the trade refuses the new key until a new revision", async () => {
  const b = buyer.page;
  await b.goto("/organization/keys");
  await waitForScreen(b);
  const mine = b.getByTestId("my-keys");
  await expect(mine.getByTestId("rotation-impact")).toContainText(tradeId);
  await mine.getByRole("button", { name: "Prepare key rotation" }).click();
  const review = b.getByTestId("rotation-review");
  await expect(review).toContainText("KEY_ROTATION");
  await expect(review).toContainText("v2");
  await review.getByRole("button", { name: "Sign rotation with the new key" }).click();
  const done = b.getByTestId("rotation-done");
  await expect(done).toContainText("still bind the previous key");
  const newKey = (await done.locator("code.address__value").innerText()).trim();
  await signIn(b, newKey, buyer.principalId);

  await b.goto("/organization/keys");
  await waitForScreen(b);
  const rows = b.getByTestId("my-keys").locator("tr[data-key-version]");
  await expect(rows.nth(0)).toHaveAttribute("data-status", "SUPERSEDED");
  await expect(rows.nth(1)).toHaveAttribute("data-status", "ACTIVE");
  await openTab(b, tradeId, "overview");
  await expect(b.getByTestId("authority-revision").locator('[data-role="buyer"]')).toContainText(
    "Bound key rotated",
  );
  // Acting with the new key is refused by the server: the revision binds version 1.
  await openTab(b, tradeId, "release");
  const lock = b.getByTestId("action-lock");
  await lock.getByRole("button", { name: "Prepare release intent", exact: true }).click();
  await expect(lock).toContainText("KEY_NOT_BOUND");
  await adminCtxPage.goto("/organization/keys");
  await waitForScreen(adminCtxPage);
  await expect(impactRow(adminCtxPage, "buyer")).toContainText("Bound key rotated");
});

test("M12 delayed recovery: the principal proves on a new device, early completion is refused, completion revokes the bound key", async ({
  browser,
}) => {
  // The resolver lost its device: a new browser generates the recovery key.
  const ctx = await browser.newContext();
  const fresh = await ctx.newPage();
  extra.push({ ctx, page: fresh, principalId: risk.principalId });
  await fresh.goto("/recovery");
  await waitForScreen(fresh);
  await fresh.getByRole("button", { name: "Generate recovery key" }).click();
  const recoveryKey = (
    await fresh.getByTestId("recovery-public-key").locator("code.address__value").innerText()
  ).trim();

  const a = adminCtxPage;
  await a.goto("/organization/keys");
  await waitForScreen(a);
  const person = a.getByTestId(`principal-${risk.principalId}`);
  await person.getByRole("button", { name: "Start recovery for Rafa Risk" }).click();
  await person.getByLabel("New public key for Rafa Risk").fill(recoveryKey);
  await person.getByRole("button", { name: "Review recovery" }).click();
  const dialog = a.getByRole("dialog", { name: "Start recovery for Rafa Risk" });
  await expect(dialog.getByTestId("affected-trades")).toContainText(tradeId);
  await dialog.getByRole("button", { name: "Start recovery" }).click();
  const startedAt = Date.now();
  const pkgPanel = a.getByTestId("recovery-package");
  await expect(pkgPanel).toBeVisible();
  const pkg = (await pkgPanel.locator("code.address__value").innerText()).trim();
  await expect(impactRow(a, "riskResolver")).toContainText("Bound key revoked or suspended");

  await fresh.getByLabel("Recovery package from your administrator").fill(pkg);
  await fresh.getByRole("button", { name: "Review recovery proof" }).click();
  const review = fresh.getByTestId("recovery-review");
  await expect(review).toContainText("RECOVERY_KEY");
  await expect(review).toContainText(risk.principalId);
  await review.getByRole("button", { name: "Sign recovery proof" }).click();
  await expect(fresh.getByTestId("recovery-done")).toContainText("WAITING");

  await a.reload();
  await waitForScreen(a);
  const rec = a.getByTestId("recoveries-table").locator('tr[data-status="WAITING"]');
  await expect(rec).toContainText(risk.principalId);
  await rec.getByRole("button", { name: "Complete recovery" }).click();
  await a
    .getByRole("dialog", { name: "Complete recovery" })
    .getByRole("button", { name: "Complete recovery" })
    .click();
  await expect(rec).toContainText("DELAY_NOT_ELAPSED");
  await checkViewports(a, "keys during recovery");

  await a.waitForTimeout(Math.max(0, startedAt + RECOVERY_DELAY_MS + 1500 - Date.now()));
  await a.reload();
  await waitForScreen(a);
  const waiting = a.getByTestId("recoveries-table").locator('tr[data-status="WAITING"]');
  await waiting.getByRole("button", { name: "Complete recovery" }).click();
  await a
    .getByRole("dialog", { name: "Complete recovery" })
    .getByRole("button", { name: "Complete recovery" })
    .click();
  await expect(a.getByTestId("recoveries-table").locator('tr[data-status="COMPLETED"]')).toContainText(
    risk.principalId,
  );
  await expect(impactRow(a, "riskResolver")).toContainText("Bound key revoked or suspended");

  await signIn(fresh, recoveryKey, risk.principalId);
  await fresh.goto("/organization/keys");
  await waitForScreen(fresh);
  const rows = fresh.getByTestId("my-keys").locator("tr[data-key-version]");
  await expect(rows.nth(0)).toHaveAttribute("data-status", "REVOKED");
  await expect(rows.nth(0)).toContainText("RECOVERED");
  await expect(rows.nth(1)).toHaveAttribute("data-status", "ACTIVE");
  await openTab(fresh, tradeId, "overview");
  await expect(fresh.getByTestId("authority-revision").locator('[data-role="riskResolver"]')).toContainText(
    "Bound key revoked or suspended",
  );
});

test("M12 a principal vetoes a recovery with its existing key; the administrator then revokes a key", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  extra.push({ ctx, page: other, principalId: auditor.principalId });
  await other.goto("/recovery");
  await waitForScreen(other);
  await other.getByRole("button", { name: "Generate recovery key" }).click();
  const k = (
    await other.getByTestId("recovery-public-key").locator("code.address__value").innerText()
  ).trim();

  const a = adminCtxPage;
  await a.goto("/organization/keys");
  await waitForScreen(a);
  const person = a.getByTestId(`principal-${auditor.principalId}`);
  await person.getByRole("button", { name: "Start recovery for Avi Auditor" }).click();
  await person.getByLabel("New public key for Avi Auditor").fill(k);
  await person.getByRole("button", { name: "Review recovery" }).click();
  const dialog = a.getByRole("dialog", { name: "Start recovery for Avi Auditor" });
  await expect(dialog.getByTestId("affected-none")).toBeVisible();
  await dialog.getByRole("button", { name: "Start recovery" }).click();
  const pkg = JSON.parse(
    (await a.getByTestId("recovery-package").locator("code.address__value").innerText()).trim(),
  ) as {
    recoveryId: string;
  };

  // The real auditor still holds its existing key and vetoes from its own browser.
  const v = auditor.page;
  await v.goto("/recovery");
  await waitForScreen(v);
  await v.getByLabel("Recovery ID").fill(pkg.recoveryId);
  await v.getByRole("button", { name: "Review veto" }).click();
  const review = v.getByTestId("recovery-review");
  await expect(review).toContainText("RECOVERY_CANCEL");
  await review.getByRole("button", { name: "Sign veto with my existing key" }).click();
  await expect(v.getByTestId("recovery-done")).toContainText("CANCELLED");
  await checkViewports(v, "recovery");

  await a.reload();
  await waitForScreen(a);
  await expect(a.locator(`tr[data-recovery="${pkg.recoveryId}"]`)).toHaveAttribute(
    "data-status",
    "CANCELLED",
  );
  await expect(a.locator(`tr[data-recovery="${pkg.recoveryId}"]`)).toContainText("Recovery vetoed");
  // The administrator cannot recover itself (separation of duties) and revokes the auditor's key.
  await expect(a.getByTestId(`principal-${adminPrincipal}`)).toContainText(
    "A different security administrator",
  );
  const auditorKeys = a.getByTestId(`principal-${auditor.principalId}`);
  await auditorKeys.locator('tr[data-key-version="1"]').getByRole("button", { name: "Revoke v1" }).click();
  const rd = a.getByRole("dialog", { name: "Revoke key v1 of Avi Auditor" });
  await rd.getByLabel("Revocation reason").selectOption("DEVICE_LOST");
  await expect(rd.getByTestId("affected-none")).toBeVisible();
  await rd.getByRole("button", { name: "Revoke key" }).click();
  await expect(auditorKeys.locator('tr[data-key-version="1"]')).toHaveAttribute("data-status", "REVOKED");
  await expect(auditorKeys.locator('tr[data-key-version="1"]')).toContainText("DEVICE_LOST");
  // No private key, custody locator or session token appears anywhere in the administrator's page.
  const html = await a.content();
  expect(html).not.toMatch(/signer:\/\/|privateKey|ed25519:[1-9A-HJ-NP-Za-km-z]{87,88}"/);
});

test("M14 an expired recovery challenge is re-issued by the administrator and the new package proves", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const eve = await inviteViaUi(browser, "AUDITOR", "Eve Expiry");
  extra.push(eve);
  const ctx = await browser.newContext();
  const device = await ctx.newPage();
  extra.push({ ctx, page: device, principalId: eve.principalId });
  await device.goto("/recovery");
  await waitForScreen(device);
  await device.getByRole("button", { name: "Generate recovery key" }).click();
  const k = (
    await device.getByTestId("recovery-public-key").locator("code.address__value").innerText()
  ).trim();

  const a = adminCtxPage;
  await a.goto("/organization/keys");
  await waitForScreen(a);
  const person = a.getByTestId(`principal-${eve.principalId}`);
  await person.getByRole("button", { name: "Start recovery for Eve Expiry" }).click();
  await person.getByLabel("New public key for Eve Expiry").fill(k);
  await person.getByRole("button", { name: "Review recovery" }).click();
  await a
    .getByRole("dialog", { name: "Start recovery for Eve Expiry" })
    .getByRole("button", { name: "Start recovery" })
    .click();
  const firstPanel = a.getByTestId("recovery-package");
  await expect(firstPanel).toBeVisible();
  const first = (await firstPanel.locator("code.address__value").innerText()).trim();
  const { recoveryId, challenge } = JSON.parse(first) as {
    recoveryId: string;
    challenge: { expiresAt: number };
  };

  // While the challenge is open the server refuses a re-issue.
  await a.reload();
  await waitForScreen(a);
  const row = a.locator(`tr[data-recovery="${recoveryId}"]`);
  await expect(row).toHaveAttribute("data-status", "PENDING_PROOF");
  await expect(row.getByTestId(`recovery-challenge-${recoveryId}`)).toContainText("open until");
  await row.getByRole("button", { name: "Re-issue recovery challenge" }).click();
  const dialog = a.getByRole("dialog", { name: "Re-issue recovery challenge" });
  await expect(dialog).toContainText("(unchanged)");
  await expectAccessible(a, "re-issue confirmation");
  await dialog.getByRole("button", { name: "Re-issue challenge" }).click();
  await expect(row).toContainText("has not expired");

  // The challenge lifetime of this stack passes; the principal can no longer use the package.
  await a.waitForTimeout(Math.max(0, challenge.expiresAt - Date.now() + 1500));
  await device.getByLabel("Recovery package from your administrator").fill(first);
  await device.getByRole("button", { name: "Review recovery proof" }).click();
  await expect(device.getByTestId("state-refused")).toContainText("challenge already expired");
  await expect(device.getByTestId("state-refused")).toContainText("re-issue the recovery challenge");
  await expect(device.getByTestId("recovery-review")).toHaveCount(0);

  // The administrator re-issues: same recovery, same new key version, same not-before.
  await a.reload();
  await waitForScreen(a);
  await expect(row.getByTestId(`recovery-challenge-${recoveryId}`)).toContainText("expired");
  await row.getByRole("button", { name: "Re-issue recovery challenge" }).click();
  await a
    .getByRole("dialog", { name: "Re-issue recovery challenge" })
    .getByRole("button", { name: "Re-issue challenge" })
    .click();
  const panel = a.getByTestId("recovery-package");
  await expect(panel).toContainText("Recovery challenge issued");
  const second = (await panel.locator("code.address__value").innerText()).trim();
  const p2 = JSON.parse(second) as {
    recoveryId: string;
    notBefore: number;
    challenge: { challengeId: string; expiresAt: number };
  };
  const p1 = JSON.parse(first) as { notBefore: number; challenge: { challengeId: string } };
  expect(p2.recoveryId).toBe(recoveryId);
  expect(p2.notBefore).toBe(p1.notBefore);
  expect(p2.challenge.challengeId).not.toBe(p1.challenge.challengeId);
  await checkViewports(a, "keys after re-issue");

  await device.getByLabel("Recovery package from your administrator").fill(second);
  await device.getByRole("button", { name: "Review recovery proof" }).click();
  const review = device.getByTestId("recovery-review");
  await expect(review).toContainText("RECOVERY_KEY");
  await review.getByRole("button", { name: "Sign recovery proof" }).click();
  await expect(device.getByTestId("recovery-done")).toContainText("WAITING");
  await checkViewports(device, "recovery proof after re-issue");
  await a.reload();
  await waitForScreen(a);
  await expect(row).toHaveAttribute("data-status", "WAITING");
});
