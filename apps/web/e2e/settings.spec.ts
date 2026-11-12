/**
 * M17 organization settings and signed audit export in the browser, against the real API process
 * and every trade module (scripts/local-stack). The chain is SIMULATED; nothing touches testnet.
 *
 * A second security administrator, an auditor and the trade parties are invited by the stack's
 * organisation administrators and accept in their own browser contexts. The administrator drafts
 * and registers an EvidencePolicy revision, changes retention (a second administrator who loaded the
 * same revision loses the compare-and-swap race), runs the RPC connection test; the auditor reads everything and can change
 * nothing; a party gets no settings at all. After a real trade is created, the buyer prepares the
 * signed audit export: the browser re-checks it, the file is downloaded and the offline verifier
 * command accepts it, and rejects a tampered copy.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { createTrade, type StackInfo } from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, openTab, type Person } from "./stack";

test.describe.configure({ mode: "serial" });

const VERIFY_CLI = fileURLToPath(new URL("../../../services/api/dist/cli/verify-export.js", import.meta.url));
const out = mkdtempSync(join(tmpdir(), "dockside-m17-e2e-"));

let info: StackInfo;
let admin: Person;
let admin2: Person;
let auditor: Person;
let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let tradeId = "";

test.beforeAll(async ({ browser }) => {
  info = await control<StackInfo>("/control/info");
  admin = await enroll(browser, "buyer", "ORG_SECURITY_ADMIN", "Acme settings administrator");
  admin2 = await enroll(browser, "buyer", "ORG_SECURITY_ADMIN", "Acme second administrator");
  auditor = await enroll(browser, "buyer", "AUDITOR", "Acme settings auditor");
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Acme export buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Acme export risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Harbor export supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Port export inspector");
});

test.afterAll(async () => {
  for (const p of [admin, admin2, auditor, buyer, supplier, inspector, risk]) await p?.ctx.close();
});

async function go(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForScreen(page);
}

test("M17 evidence policies: the owning administrator drafts and registers a revision; others read only", async () => {
  const a = admin.page;
  await go(a, "/organization/policies");
  const pol = a.getByTestId("policy-commercial-docs");
  await expect(pol).toContainText("Your organization");
  await expect(pol.getByTestId("policy-revisions-commercial-docs")).toContainText("1");
  const draft = a.getByTestId("policy-draft-commercial-docs");
  await expect(draft).toContainText("Draft revision 2");
  await expectAccessible(a, "policies (admin)");
  // An invalid value is refused in the form; then a real change.
  await draft.getByLabel("Freshness of inspection-report (days)").fill("0");
  await expect(draft).toContainText("Enter whole days from 1 to 365.");
  await draft.getByLabel("Freshness of inspection-report (days)").fill("5");
  await expect(draft.getByTestId("draft-changes")).toContainText(
    "inspection-report freshness 7 days → 5 days",
  );
  await draft.getByRole("button", { name: "Review revision 2" }).click();
  const dlg = a.getByRole("dialog", { name: "Register commercial-docs revision 2?" });
  await expect(dlg).toBeVisible();
  await expectAccessible(a, "policy confirmation dialog");
  await dlg.getByRole("button", { name: "Register revision" }).click();
  await expect(a.getByTestId("policy-registered")).toContainText("Revision 2 registered");
  const rows = a.getByTestId("policy-revisions-commercial-docs").locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator("td").first()).toHaveText("2");

  // The auditor reads the same policy and gets no draft form.
  await go(auditor.page, "/organization/policies");
  await expect(auditor.page.getByTestId("policy-revisions-commercial-docs").locator("tbody tr")).toHaveCount(
    2,
  );
  await expect(auditor.page.getByTestId("policy-draft-commercial-docs")).toHaveCount(0);
  await expect(auditor.page.getByTestId("policy-readonly-commercial-docs")).toBeVisible();
  // The supplier organisation sees the policy because its trades may bind it, but cannot extend it.
  // A party has no settings at all.
  await go(buyer.page, "/organization/policies");
  await expect(buyer.page.getByTestId("settings-role")).toBeVisible();
  await expect(buyer.page.locator("table")).toHaveCount(0);
});

test("M17 trade for the export: the buyer proposes, the supplier countersigns, the contract registers it", async () => {
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "export-17", amountNear: "2" },
  );
  expect(tradeId).toMatch(/^trd_[0-9a-f]{32}$/);
});

test("M17 retention: compare-and-swap save, stale administrator refused, auditor read-only, eligibility preview", async () => {
  const a = admin.page;
  await go(a, "/organization/retention");
  // A second administrator, in its own session, loads the same revision before the first one saves.
  const stale = admin2.page;
  await go(stale, "/organization/retention");
  const panel = a.getByTestId("retention-panel");
  await expect(panel).toContainText("365 days after a trade settles");
  await expect(a.getByTestId("retention-preview")).toContainText(tradeId);
  await expect(a.getByTestId("retention-preview")).toContainText("Not settled");
  await expect(a.getByTestId("retention-preview")).toContainText("no evidence object is deleted");
  await expectAccessible(a, "retention (admin)");
  await panel.getByLabel("Evidence retention after settlement (days)").fill("12");
  await expect(panel).toContainText("Enter whole days from 30 to 3650.");
  await panel.getByLabel("Evidence retention after settlement (days)").fill("180");
  await panel.getByRole("button", { name: "Review change" }).click();
  const dlg = a.getByRole("dialog", { name: "Change evidence retention?" });
  await expect(dlg).toContainText("365 days → 180 days");
  await dlg.getByRole("button", { name: "Save retention period" }).click();
  await expect(a.getByTestId("retention-saved")).toContainText("Settings revision 1 saved");
  await expect(panel).toContainText("180 days after a trade settles");
  await expect(a.getByTestId("settings-history")).toContainText("180 days");

  const sp = stale.getByTestId("retention-panel");
  await sp.getByLabel("Evidence retention after settlement (days)").fill("90");
  await sp.getByRole("button", { name: "Review change" }).click();
  await stale
    .getByRole("dialog", { name: "Change evidence retention?" })
    .getByRole("button", { name: "Save retention period" })
    .click();
  await expect(stale.getByTestId("retention-failure")).toContainText("VERSION_CONFLICT");
  await expect(stale.getByTestId("retention-failure")).toContainText("Someone changed these settings");
  await go(a, "/organization/retention");
  await expect(panel).toContainText("180 days after a trade settles");

  await go(auditor.page, "/organization/retention");
  await expect(auditor.page.getByTestId("retention-readonly")).toBeVisible();
  await expect(auditor.page.getByLabel("Evidence retention after settlement (days)")).toHaveCount(0);
  await expect(auditor.page.getByTestId("settings-history")).toContainText("180 days");

  // The change and the refused write are in the organisation's audit log.
  await go(auditor.page, "/audit");
  await expect(auditor.page.locator("main")).toContainText("ORGANIZATION_SETTINGS_CHANGED");
  await expect(auditor.page.locator("main")).toContainText("EVIDENCE_POLICY_REGISTERED");
});

test("M17 integrations: RPC connection test proves connectivity only; 1Click NOT_RUN; export key listed", async () => {
  const a = admin.page;
  await go(a, "/organization/integrations");
  await expect(a.getByTestId("rpc-panel")).toContainText("http://127.0.0.1");
  await expect(a.getByTestId("oneclick-panel")).toContainText("Dry compatibility: not run");
  await expect(a.getByTestId("oneclick-panel")).toContainText("secrets are write-only");
  await expect(a.getByTestId("export-keys-panel")).toContainText("Active");
  await expect(a.getByTestId("export-keys-panel")).toContainText("Isolated signer process");
  await a.getByRole("button", { name: "Test connection" }).click();
  await expect(a.getByTestId("rpc-test-result")).toContainText(/Reachable: final block \d+/);
  await expect(a.getByTestId("rpc-test-result")).toContainText("connectivity only");
  await expectAccessible(a, "integrations (admin)");
  await go(auditor.page, "/organization/integrations");
  await expect(auditor.page.getByRole("button", { name: "Test connection" })).toHaveCount(0);
});

test("M17 signed audit export: verified in the browser, downloaded, and accepted by the offline verifier", async () => {
  const b = buyer.page;
  await openTab(b, tradeId, "timeline");
  const panel = b.getByTestId("signed-export");
  await panel.getByRole("button", { name: "Prepare signed export" }).click();
  await expect(panel.getByTestId("signed-export-verdict")).toContainText(
    "Signature verified in this browser",
    {
      timeout: 30_000,
    },
  );
  await expect(panel).toContainText("Holds: Export checksum recomputed in this browser");
  await expectAccessible(b, "signed export (buyer)");
  const [bundleDl] = await Promise.all([
    b.waitForEvent("download"),
    panel.getByRole("link", { name: "Save signed export" }).click(),
  ]);
  const [keysDl] = await Promise.all([
    b.waitForEvent("download"),
    panel.getByRole("link", { name: "Save export key list" }).click(),
  ]);
  const bundleFile = join(out, "signed.json");
  const keysFile = join(out, "keys.json");
  await bundleDl.saveAs(bundleFile);
  await keysDl.saveAs(keysFile);
  const ok = spawnSync(process.execPath, [VERIFY_CLI, bundleFile, "--trusted-keys", keysFile], {
    encoding: "utf8",
  });
  expect(ok.status, ok.stdout + ok.stderr).toBe(0);
  expect(ok.stdout).toContain(`VERIFIED: trade ${tradeId}`);
  const bundle = JSON.parse(readFileSync(bundleFile, "utf8"));
  expect(bundle.export.destinations).toBe("MASKED");
  bundle.export.sections.revisions = [];
  const tampered = join(out, "tampered.json");
  writeFileSync(tampered, JSON.stringify(bundle));
  const bad = spawnSync(process.execPath, [VERIFY_CLI, tampered, "--trusted-keys", keysFile], {
    encoding: "utf8",
  });
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain("FAIL  export.checksum");
});

test("M17 settings screens pass axe and fit at every width, signed in as administrator", async () => {
  const a = admin.page;
  for (const vp of VIEWPORTS) {
    await a.setViewportSize({ width: vp.width, height: vp.height });
    for (const r of ["/organization/policies", "/organization/retention", "/organization/integrations"]) {
      await go(a, r);
      await expectNoBodyOverflow(a, `${r} @${vp.name}`);
      await expectAccessible(a, `${r} @${vp.name}`);
    }
  }
  await a.setViewportSize({ width: 1440, height: 900 });
});
