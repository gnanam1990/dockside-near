/**
 * M43 product path in the browser against a REAL nearcore node (local sandbox), with the testnet
 * runtime profile: the real API and worker processes, the production relayer signer
 * (function-call key restricted to the escrow, loaded from a near-cli-rs key file), the party relay
 * and the ManifestAttestor / deterministic-policy services with their keys in isolated signer
 * processes (e2e-sandbox/runtime.ts). Nothing is simulated and nothing is intercepted; there is no
 * control port. Every transaction below is a real nearcore transaction.
 *
 * Three organisations are bootstrapped in the browser; their administrators register the evidence
 * policy, enrol the services (the custody tool signs the proof-of-possession challenge), invite the
 * buyer approver, risk/policy resolver, supplier signer and inspector, who accept in their own
 * browser contexts. Then: propose, countersign and relay registration; the buyer's own wallet sends
 * the exact `fund` call the funding panel shows; evidence uploads; the attestor service attests on
 * chain; the inspector signs PASS; the buyer locks and approves; the worker executes the release
 * with the relayer key; PAID, and the supplier's on-chain balance grows by exactly the amount.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { JsonRpcNearClient } from "../../../packages/near/dist/index.js";
import { keyFromFile, walletCall } from "../../../scripts/near-sandbox/product-chain.mjs";
import { bootstrapOrganization, expectAccessible, waitForScreen } from "../e2e/helpers";
import { eventually, openTab, type Person, pdf, png } from "../e2e/stack";
import { ROOT, type SandboxRuntimeInfo } from "./runtime";

test.describe.configure({ mode: "serial" });

const AMOUNT_NEAR = "0.05";
const AMOUNT_YOCTO = "50000000000000000000000";
const POLICY_ID = "commercial-docs";

let info: SandboxRuntimeInfo;
const admins: Record<"buyer" | "supplier" | "inspector", Page> = {} as never;
let buyer: Person;
let risk: Person;
let supplier: Person;
let inspector: Person;
let tradeId = "";
const evidence: { step: string; txHash: string; signer: string }[] = [];

const rpc = () =>
  new JsonRpcNearClient({
    endpoint: info.rpcUrl,
    allowedHosts: ["127.0.0.1"],
    timeoutMs: 30_000,
    maxResponseBytes: 4 << 20,
  });

const principalOf = async (page: Page) =>
  (
    await page
      .getByTestId("me-panel")
      .locator("dt", { hasText: /^Principal$/ })
      .locator("xpath=following-sibling::dd")
      .innerText()
  ).trim();

/** The organisation administrator invites in the browser; the person accepts in a fresh context. */
async function invite(browser: Browser, admin: Page, capability: string, name: string): Promise<Person> {
  await admin.goto("/organization");
  await waitForScreen(admin);
  await admin.getByLabel("Capability", { exact: true }).selectOption(capability);
  await admin.getByRole("button", { name: "Create invitation" }).click();
  const created = admin.getByTestId("invitation-created");
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
  await admin.getByLabel("Invitation ID").fill(invitationId);
  await admin.getByRole("button", { name: "Review grant" }).click();
  await admin
    .getByRole("dialog", { name: "Grant capability" })
    .getByRole("button", { name: "Grant capability" })
    .click();
  await expect(admin.getByText("Capability granted")).toBeVisible();
  await page.reload();
  await waitForScreen(page);
  await expect(page.getByTestId("me-panel")).not.toContainText("Pending grant");
  return { ctx, page, principalId: await principalOf(page) };
}

/** Enrol a service whose key the custody tool generated; the tool signs the PoP challenge. */
async function enrollService(
  page: Page,
  serviceId: string,
  capability: "MANIFEST_ATTEST" | "DETERMINISTIC_POLICY_SET",
  publicKey: string,
  keyFile: string,
): Promise<void> {
  const form = page.getByTestId("enroll-service");
  await form.getByLabel("Service ID", { exact: true }).fill(serviceId);
  await form.getByLabel("Service capability").selectOption(capability);
  await form.getByLabel("EvidencePolicy ID").fill(POLICY_ID);
  await form.getByLabel("EvidencePolicy revision").fill("1");
  await form.getByLabel("Service public key").fill(publicKey);
  await form.getByLabel("Custody kind").selectOption("ISOLATED_SIGNER_PROCESS");
  await form.getByLabel("Custody locator (write-only)").fill(`signer://${serviceId}/v1`);
  await form.getByRole("button", { name: "Review enrollment" }).click();
  await page
    .getByRole("dialog", { name: "Enroll service identity" })
    .getByRole("button", { name: "Enroll service" })
    .click();
  const panel = page.getByTestId("service-proof");
  await expect(panel).toBeVisible();
  const raw = (await panel.locator("code.address__value").nth(2).innerText()).trim();
  const challengeFile = join(info.dir, `${serviceId}-challenge.json`);
  writeFileSync(challengeFile, raw);
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "services/api/dist/cli/service-key.js"),
      "sign-challenge",
      "--capability",
      capability,
      "--key-file",
      keyFile,
      "--challenge-file",
      challengeFile,
    ],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  const { signature } = JSON.parse(r.stdout) as { signature: string };
  await panel.getByLabel("Signature returned by the custody").fill(signature);
  await panel.getByRole("button", { name: "Submit custody proof" }).click();
  await expect(page.getByTestId("service-proved")).toBeVisible();
  const card = page.getByTestId(`service-${serviceId}`);
  await card.getByRole("button", { name: "Activate v1" }).click();
  await page
    .getByRole("dialog", { name: `Activate ${serviceId} v1` })
    .getByRole("button", { name: "Activate v1" })
    .click();
  await expect(card.locator('[data-dimension="enrollmentStatus"]')).toHaveAttribute("data-value", "ACTIVE");
}

/**
 * Submit through the relay and read its answer as the browser received it (observed, not
 * intercepted): the relayer's transaction hash and the contract outcome. Some panels are replaced by
 * their "done" state as soon as the call lands, so the response is read rather than the panel text.
 */
async function relayed(panel: ReturnType<Page["getByTestId"]>, step: string): Promise<string> {
  const answer = panel
    .page()
    .waitForResponse((r) => r.url().endsWith("/relay/v1/calls"), { timeout: 120_000 });
  await panel.getByRole("button", { name: "Submit to the escrow contract" }).click();
  const r = (await (await answer).json()) as {
    txHash: string;
    outcome: string;
    method: string;
    error: unknown;
  };
  expect(r, JSON.stringify(r)).toMatchObject({ outcome: "FINAL_SUCCESS", method: step });
  expect(r.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
  evidence.push({ step, txHash: r.txHash, signer: info.accounts.relayer });
  return r.txHash;
}

/** Prepare → review → sign → relay with the relayer key, recording the transaction hash. */
async function signAndRelay(
  page: Page,
  id: string,
  start: string,
  sign: string,
  step: string,
): Promise<void> {
  const box = page.getByTestId(`action-${id}`);
  await box.getByRole("button", { name: start, exact: true }).click();
  const review = box.getByTestId(`review-${id}`);
  await expect(review).toContainText("Digest recomputed by this browser");
  await review.getByRole("button", { name: sign }).click();
  await relayed(box.getByTestId("relay-panel"), step);
  await expect(box.getByTestId(`done-${id}`)).toBeVisible({ timeout: 90_000 });
}

test.beforeAll(async ({ browser }) => {
  info = JSON.parse(readFileSync(String(process.env["DOCKSIDE_SBX_INFO"]), "utf8")) as SandboxRuntimeInfo;
  for (const [org, name] of [
    ["buyer", "Acme Imports"],
    ["supplier", "Harbor Supply"],
    ["inspector", "Port Inspections"],
  ] as const) {
    const page = await (await browser.newContext()).newPage();
    await bootstrapOrganization(page, name);
    admins[org] = page;
  }
});

test.afterAll(async () => {
  for (const p of [buyer, risk, supplier, inspector]) await p?.ctx.close();
  // Service submissions (attestor, policy) are logged by the worker with their transaction hashes.
  const services = readFileSync(join(info.evidenceDir, "worker.log"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes('"attestor.submitted"') || l.includes('"policy.hold_set"'))
    .map((l) => JSON.parse(l) as Record<string, string>);
  for (const a of Object.values(admins)) await a.context().close();
  writeFileSync(
    join(info.evidenceDir, "product-run.json"),
    `${JSON.stringify(
      {
        schema: "dockside/m43-sandbox-product-run@1",
        chain: "local near-sandbox (nearcore), NOT testnet",
        chainId: info.chainId,
        accounts: info.accounts,
        tradeId,
        setupTransactions: info.setupTxs,
        productTransactions: evidence,
        serviceTransactions: services,
      },
      null,
      2,
    )}\n`,
  );
});

test("administrators register the evidence policy, enrol the services and invite the trade roles", async ({
  browser,
}) => {
  const a = admins.buyer;
  await a.goto("/organization/policies");
  await waitForScreen(a);
  const np = a.getByTestId("policy-new");
  await np.getByRole("button", { name: "Use the commercial documents template" }).click();
  await np.getByRole("button", { name: "Review new policy" }).click();
  await a
    .getByRole("dialog", { name: `Register ${POLICY_ID} revision 1?` })
    .getByRole("button", { name: "Register policy" })
    .click();
  await expect(a.getByTestId("policy-created")).toContainText(`${POLICY_ID} revision 1 registered`);
  await expect(a.getByTestId(`policy-${POLICY_ID}`)).toContainText("Your organization");
  await expectAccessible(a, "policies with the new-policy form");

  await a.goto("/organization/services");
  await waitForScreen(a);
  await enrollService(
    a,
    "manifest-attestor",
    "MANIFEST_ATTEST",
    info.services.attestor,
    info.serviceKeyFiles.attestor,
  );
  await enrollService(
    a,
    "deterministic-policy",
    "DETERMINISTIC_POLICY_SET",
    info.services.policy,
    info.serviceKeyFiles.policy,
  );

  buyer = await invite(browser, admins.buyer, "BUYER_APPROVER", "Dana Buyer");
  risk = await invite(browser, admins.buyer, "RISK_RESOLVER", "Riya Risk");
  supplier = await invite(browser, admins.supplier, "SUPPLIER_SIGNER", "Sam Supplier");
  inspector = await invite(browser, admins.inspector, "INSPECTOR", "Ines Inspector");
});

test("buyer proposes, supplier countersigns, the relayer registers the trade and its policy on chain", async () => {
  const b = buyer.page;
  await b.goto("/trades/new");
  await waitForScreen(b);
  await b.getByLabel("Supplier signer principal ID").fill(supplier.principalId);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Amount (native testnet NEAR)").fill(AMOUNT_NEAR);
  await b.getByLabel("Milestone reference").fill("shipment-1");
  await b.getByLabel("Milestone", { exact: true }).fill("Container MSCU1234565 loaded and inspected");
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Supplier NEAR testnet account").fill(info.accounts.supplier);
  await b.getByLabel("Buyer funding NEAR testnet account").fill(info.accounts.buyer);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByLabel("Named inspector principal ID").fill(inspector.principalId);
  await b.getByLabel("Risk/policy resolver principal ID").fill(risk.principalId);
  await b.getByLabel("Evidence policy ID").fill(POLICY_ID);
  await b.getByRole("button", { name: "Continue" }).click();
  await b.getByRole("button", { name: "Request canonical agreement" }).click();
  const review = b.getByTestId("proposal-review");
  await expect(review).toContainText(info.accounts.escrow);
  await expect(review).toContainText(AMOUNT_YOCTO);
  await expect(review).toContainText("manifest-attestor");
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
  // The relay panel names the real relayer, not a simulated chain.
  await expect(submitted.getByTestId("relay-panel").first()).toContainText(info.accounts.relayer);
  await expect(submitted.getByTestId("relay-panel").first()).not.toContainText("simulated");
  await relayed(submitted.getByTestId("relay-panel").first(), "register_trade");
  await relayed(submitted.getByTestId("relay-panel").nth(1), "register_evidence_policy");
  await expect(s.getByTestId("trade-registered")).toBeVisible();
});

test("the buyer's own wallet sends the exact fund call the funding panel shows", async () => {
  const b = buyer.page;
  await openTab(b, tradeId, "overview");
  const panel = b.getByTestId("funding-wallet");
  await expect(panel).toContainText(info.accounts.buyer);
  await expect(panel).toContainText(`${AMOUNT_YOCTO} yoctoNEAR`);
  await expect(panel).toContainText("near contract call-function as-transaction");
  await expectAccessible(b, "funding wallet panel");
  const call = JSON.parse((await panel.locator("code.address__value").first().innerText()).trim());
  expect(call).toMatchObject({
    receiverId: info.accounts.escrow,
    methodName: "fund",
    depositYocto: AMOUNT_YOCTO,
  });
  // The relay refuses a deposit-carrying call: only the funder's own wallet can send it.
  const refused = await b.evaluate(async (c) => {
    const r = await fetch("/relay/v1/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call: c }),
    });
    return r.status;
  }, call);
  expect(refused).toBe(403);
  const sent = await walletCall(info.rpcUrl, keyFromFile(info.buyerKeyFile), call);
  evidence.push({ step: "fund", txHash: sent.txHash, signer: info.accounts.buyer });
  await eventually(b, async () => {
    await openTab(b, tradeId, "overview");
    await expect(b.getByTestId("funding")).toContainText("Yes (contract ledger)", { timeout: 5_000 });
  });
  await expect(b.getByTestId("funding-wallet")).toHaveCount(0);
});

test("evidence is uploaded, the attestor service attests on chain and the inspector signs PASS", async () => {
  const s = supplier.page;
  await openTab(s, tradeId, "evidence");
  const invoice = s.getByTestId("slot-commercial-invoice");
  await invoice.getByLabel("File for commercial-invoice").setInputFiles({
    name: "invoice-INV-1.pdf",
    mimeType: "application/pdf",
    buffer: pdf("Commercial invoice INV-1 total 0.05 NEAR"),
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
    buffer: Buffer.from("Inspection report: 12 pallets, seals intact, grade A.\n"),
  });
  await report.getByRole("button", { name: "Upload to inspection-report" }).click();
  await expect(report.getByTestId("upload-inspection-report-status")).toContainText(
    "manifest is now revision",
  );
  const photos = i.getByTestId("slot-cargo-photos");
  await photos
    .getByLabel("File for cargo-photos")
    .setInputFiles({ name: "cargo.png", mimeType: "image/png", buffer: png(32, 16) });
  await photos.getByRole("button", { name: "Upload to cargo-photos" }).click();
  await expect(photos.getByTestId("upload-cargo-photos-status")).toContainText("manifest is now revision");

  // The ManifestAttestor service (isolated signer in the worker) attests and relays on chain.
  await eventually(
    i,
    async () => {
      await i.reload();
      await waitForScreen(i);
      await expect(i.getByTestId("attestation-panel")).toContainText("Attestation current", {
        timeout: 5_000,
      });
    },
    180_000,
  );
  await i.getByTestId("inspector-workbench").getByLabel("PASS").check();
  await i.getByLabel("Reason code", { exact: true }).fill("DOCS_MATCH");
  await signAndRelay(i, "inspect", "Prepare inspection", "Sign inspection", "submit_inspection");
});

test("the buyer locks and approves; the worker releases with the relayer key; PAID with the exact amount", async () => {
  const supplierBefore = (await rpc().viewAccount(info.accounts.supplier)).amountYocto;
  const b = buyer.page;
  await openTab(b, tradeId, "release");
  await eventually(
    b,
    async () => {
      await b.reload();
      await waitForScreen(b);
      await expect(b.getByTestId("action-lock")).toBeVisible({ timeout: 5_000 });
    },
    120_000,
  );
  await signAndRelay(b, "lock", "Prepare release intent", "Sign release intent", "create_release_intent");
  await eventually(b, async () => expect(b.getByTestId("action-approve")).toBeVisible({ timeout: 5_000 }));
  await signAndRelay(b, "approve", "Prepare approval", "Sign approval", "approve_release");

  await openTab(b, tradeId, "release");
  await eventually(b, async () => expect(b.getByTestId("execute-release")).toBeVisible({ timeout: 5_000 }));
  await b.getByRole("button", { name: "Execute direct release" }).click();
  const dialog = b.getByRole("dialog", { name: "Execute direct release" });
  await expect(dialog).toContainText(info.accounts.supplier);
  await dialog.getByRole("button", { name: "Queue release" }).click();
  await expect(b.getByTestId("execute-status")).toContainText("is QUEUED");

  await openTab(b, tradeId, "payout");
  await eventually(
    b,
    async () => {
      await b.reload();
      await waitForScreen(b);
      await expect(b.getByTestId("operation").first()).toHaveAttribute("data-state", "PAID", {
        timeout: 5_000,
      });
    },
    240_000,
  );
  const op = b.getByTestId("operation").first();
  await expect(op).toContainText("Paid (terminal evidence recorded)");
  const releaseTx = (
    await op
      .locator("dt", { hasText: /^Source transaction$/ })
      .locator("xpath=following-sibling::dd")
      .innerText()
  ).trim();
  expect(releaseTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);
  evidence.push({ step: "execute_release (worker)", txHash: releaseTx, signer: info.accounts.relayer });
  // The chain itself: the supplier received exactly the trade amount.
  const supplierAfter = (await rpc().viewAccount(info.accounts.supplier)).amountYocto;
  expect(supplierAfter - supplierBefore).toBe(BigInt(AMOUNT_YOCTO));
  const tx = await rpc().request("tx", {
    tx_hash: releaseTx,
    sender_account_id: info.accounts.relayer,
    wait_until: "FINAL",
  });
  expect(JSON.stringify(tx)).toContain("execute_release");
  await openTab(b, tradeId, "overview");
  await expect(b.getByTestId("funding")).toContainText("Released");
  await expectAccessible(b, "overview after PAID");
});
