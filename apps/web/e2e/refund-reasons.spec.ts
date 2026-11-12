/**
 * M15 in the browser (T-009 reason rows, T-010 races, REAL-PRODUCT-GATE items 9 and 11), against
 * the real API and every trade module (scripts/local-stack) on a SIMULATED NEAR chain, in four
 * separately enrolled browser sessions (own device key, own PoP session each):
 *
 * - TRADE_EXPIRY, INSPECTION_FAIL and PERMANENT_HOLD driven to REFUNDED to the original funder,
 *   with their dispute, appeal and revocation branches, on the contract's own clock. Their 24- and
 *   48-hour windows cannot be shortened, so the simulated chain clock moves forward twice, after
 *   every step that needs a non-refund payload; the refund routes anchor their payload windows to
 *   the contract clock and keep working once the chain runs ahead of the API's wall clock.
 * - A real race of release against refund: the buyer's release-intent lock and the supplier's
 *   mutual-cancellation request are submitted at the same instant from two browser contexts;
 *   exactly one lock wins and exactly one value movement follows.
 * - Destination activation during a live refund: prepared before the refund existed, refused by
 *   the contract once it does (VALUE_LOCKED), refused by the API afterwards, and refused again
 *   after the refund settled (INVALID_STATE): the payout destination never changes.
 * Every movement is checked against the simulated chain's own balances (/control/balances).
 */
import { expect, type Page, test } from "@playwright/test";
import { completeEvidence, createTrade, fund, inspect, inspectPass, NEAR, type StackInfo } from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, eventually, openTab, type Person, signAction } from "./stack";

test.describe.configure({ mode: "serial" });

let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let info: StackInfo & { attestationLifetimeMs: number };
const trades = { expiry: "", fail: "", hold: "", race: "", dest: "" };
const ids: Record<string, string> = {};
let consentedAt = 0;
let raceWinner: "RELEASE" | "REFUND" | "" = "";
let start: Record<string, bigint> = {};

const HOUR = 3600_000;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const people = () => ({ buyer, supplier, inspector, risk });
const balances = async () =>
  Object.fromEntries(
    Object.entries(await control<Record<string, string>>("/control/balances")).map(([k, v]) => [
      k,
      BigInt(v),
    ]),
  );
const bucket = (page: Page, funder: string, name: string) =>
  page.locator(`[data-testid="funder-buckets"] tr[data-funder="${funder}"] td[data-bucket="${name}"]`);
const candidate = (page: Page, funder: string, reason: string) =>
  page.locator(`[data-testid="candidate"][data-funder="${funder}"][data-reason="${reason}"]`);
const card = (page: Page, id: string) => page.locator(`[data-testid="refund-intent"][data-id="${id}"]`);

/** Request a refund for one funder slice in `p`'s session; returns the new intent id. */
async function request(p: Page, tradeId: string, reason: string, funder: string): Promise<string> {
  await openTab(p, tradeId, "refund");
  const before = new Set(
    await p
      .locator(`[data-testid="refund-intent"][data-reason="${reason}"]`)
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-id") ?? "")),
  );
  await signAction(
    p,
    `refund-${slug(reason)}-${slug(funder)}`,
    "Prepare refund request",
    "Sign refund request",
  );
  await openTab(p, tradeId, "refund");
  const now = await p
    .locator(`[data-testid="refund-intent"][data-reason="${reason}"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-id") ?? ""));
  const fresh = now.filter((x) => !before.has(x));
  expect(fresh).toHaveLength(1);
  return fresh[0] as string;
}

/** A signed refund action the contract refuses on relay; the page shows the contract's code. */
async function signRefused(p: Page, id: string, startLabel: string, signLabel: string, code: string) {
  const box = p.getByTestId(`action-${id}`);
  await box.getByRole("button", { name: startLabel, exact: true }).click();
  const review = box.getByTestId(`review-${id}`);
  await expect(review).toContainText("Digest recomputed by this browser");
  await review.getByRole("button", { name: signLabel }).click();
  await box.getByTestId("relay-panel").getByRole("button", { name: "Submit to the escrow contract" }).click();
  await expect(box.getByTestId("relay-status")).toContainText(code);
}

/** Permissionless authorization relay; `code` null means the contract must accept it. */
async function authorize(p: Page, tradeId: string, rid: string, code: string | null) {
  await openTab(p, tradeId, "refund");
  const box = p.getByTestId(`action-authorize-${slug(rid)}`);
  await box.getByRole("button", { name: "Prepare authorization" }).click();
  await box.getByTestId("relay-panel").getByRole("button", { name: "Submit to the escrow contract" }).click();
  if (code) await expect(box.getByTestId(`refusal-authorize-${slug(rid)}`)).toContainText(code);
  else await expect(box.getByTestId("relay-status")).toContainText("Contract accepted");
}

async function execute(p: Page, tradeId: string, rid: string, funder: string, near: bigint) {
  await openTab(p, tradeId, "refund");
  await card(p, rid).getByRole("button", { name: "Execute refund" }).click();
  const dialog = p.getByRole("dialog", { name: "Execute refund" });
  await expect(dialog).toContainText(funder);
  await expect(dialog).toContainText(`${near} NEAR`);
  await dialog.getByRole("button", { name: "Queue refund" }).click();
  await expect(p.getByTestId(`execute-status-execute-${slug(rid)}`)).toContainText("is QUEUED");
}

async function waitState(p: Page, tradeId: string, rid: string, state: string, timeoutMs = 60_000) {
  await eventually(
    p,
    async () => {
      await openTab(p, tradeId, "refund");
      await expect(card(p, rid)).toHaveAttribute("data-state", state, { timeout: 2_000 });
    },
    timeoutMs,
  );
}

async function holdId(p: Page, tradeId: string): Promise<string> {
  await eventually(p, async () => {
    await openTab(p, tradeId, "evidence");
    await expect(p.getByTestId("hold").first()).toHaveAttribute("data-status", "ACTIVE", { timeout: 2_000 });
  });
  return (await p.getByTestId("hold").first().locator("h4 code").innerText()).trim();
}

async function resolveToRefund(tradeId: string, hold: string) {
  const r = risk.page;
  await openTab(r, tradeId, "evidence");
  const rh = r.getByTestId("hold").first();
  await rh.getByLabel("Resolution").selectOption("RESOLVE_TO_REFUND");
  await signAction(r, `resolve-${hold}`, "Prepare resolution", "Sign resolution");
  await eventually(r, async () => {
    await openTab(r, tradeId, "evidence");
    await expect(r.getByTestId("hold").first()).toHaveAttribute("data-status", "RESOLVED", {
      timeout: 2_000,
    });
  });
}

/**
 * What became of a signed action's relay: "Contract accepted" once the action finished (its done
 * line), or the relay panel's refusal text with the contract's code.
 */
async function relayOutcome(box: ReturnType<Page["getByTestId"]>, id: string): Promise<string> {
  let out = "";
  await expect(async () => {
    if (await box.getByTestId(`done-${id}`).isVisible()) out = "Contract accepted";
    else {
      const t = (await box.getByTestId("relay-status").allInnerTexts()).join(" ");
      expect(t).toContain("Contract did not accept");
      out = t;
    }
  }).toPass({ timeout: 30_000 });
  return out;
}

async function chainAhead(ms: number) {
  await control("/control/chain-time", { advanceMs: ms });
}

test.beforeAll(async ({ browser }) => {
  info = await control("/control/info");
  expect(info.attestationLifetimeMs).toBe(4 * 24 * HOUR);
  expect(info.destinationChangeDelayMs).toBe(60_000);
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Bo Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Ria Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Sam Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Isa Inspector");
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("setup: five trades registered and funded by their original funders; a destination change is consented", async () => {
  test.setTimeout(300_000);
  start = await balances();
  trades.dest = await createTrade(info, people(), { milestone: "dest-live-refund", amountNear: "10" });
  await fund(trades.dest, info.accounts.buyer, 10n);
  // The supplier proposes harbor-payouts; the buyer consents in its own session: the delay starts.
  const s = supplier.page;
  await openTab(s, trades.dest, "agreement");
  await s.getByLabel("New payout destination (NEAR testnet account)").fill(info.accounts.supplierAlt);
  await signAction(s, "dest-start", "Prepare destination revision", "Sign my consent");
  const b = buyer.page;
  await openTab(b, trades.dest, "agreement");
  const consent = b.getByTestId("action-dest-consent");
  await consent.getByRole("button", { name: "Review the successor revision", exact: true }).click();
  await consent.getByTestId("review-dest-consent").getByRole("button", { name: "Sign my consent" }).click();
  await consent
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" })
    .click();
  await expect(consent.getByTestId("done-dest-consent")).toBeVisible();
  consentedAt = Date.now();

  trades.expiry = await createTrade(info, people(), {
    milestone: "expiry-1",
    amountNear: "10",
    expiresInDays: "1",
  });
  trades.fail = await createTrade(info, people(), { milestone: "inspect-fail-1", amountNear: "10" });
  trades.hold = await createTrade(info, people(), { milestone: "perm-hold-1", amountNear: "10" });
  trades.race = await createTrade(info, people(), { milestone: "race-1", amountNear: "10" });
  for (const t of [trades.expiry, trades.fail, trades.hold]) {
    await fund(t, info.accounts.buyer, 6n);
    await fund(t, info.accounts.treasury, 4n);
  }
  await fund(trades.race, info.accounts.buyer, 10n);
  await openTab(b, trades.expiry, "refund");
  await expect(candidate(b, info.accounts.buyer, "TRADE_EXPIRY")).toHaveAttribute(
    "data-blocked",
    "NOT_ELIGIBLE",
  );
  await expect(b.getByTestId("contract-clock")).toContainText("UTC");
});

test("T-009 INSPECTION_FAIL: FAIL sets a policy hold; requests lock each slice; the supplier's appeal pauses in REVIEW and risk revokes it", async () => {
  test.setTimeout(300_000);
  const t = trades.fail;
  await completeEvidence(supplier.page, inspector.page, t);
  await inspect(inspector.page, t, "FAIL", "DOCS_MISMATCH");
  ids["failHold"] = await holdId(buyer.page, t);
  const b = buyer.page;
  ids["failBuyer"] = await request(b, t, "INSPECTION_FAIL", info.accounts.buyer);
  ids["failTreasury"] = await request(b, t, "INSPECTION_FAIL", info.accounts.treasury);
  const c = card(b, ids["failBuyer"] as string);
  await expect(c).toHaveAttribute("data-state", "TIMELOCKED");
  await expect(c.getByTestId("refund-deadline")).toContainText("on the contract clock");
  await expect(bucket(b, info.accounts.buyer, "refundLocked")).toHaveAttribute(
    "data-yocto",
    (6n * NEAR).toString(),
  );
  // The buyer has no appeal; the supplier appeals the treasury slice with a statement kept in its browser.
  const tr = slug(ids["failTreasury"] as string);
  await expect(b.getByTestId(`action-dispute-${tr}`)).toHaveCount(0);
  const s = supplier.page;
  await openTab(s, t, "refund");
  const box = s.getByTestId(`action-dispute-${tr}`);
  await expect(box).toContainText("Appeal this refund");
  await box.getByLabel("Dispute reason code").fill("REINSPECT");
  await box.getByLabel("Dispute statement").fill("Seals were re-photographed; request a second inspection.");
  await signAction(s, `dispute-${tr}`, "Prepare dispute", "Sign dispute");
  await openTab(s, t, "refund");
  await expect(card(s, ids["failTreasury"] as string)).toHaveAttribute("data-state", "REVIEW");
  await expect(s.getByTestId(`action-revoke-${tr}`)).toHaveCount(0);
  for (const vp of VIEWPORTS) {
    await s.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(s, t, "refund");
    await expectNoBodyOverflow(s, `inspection-fail appeal @${vp.name}`);
    await expectAccessible(s, `inspection-fail appeal @${vp.name}`);
  }
  await s.setViewportSize({ width: 1280, height: 900 });
  // Risk/policy resolves to retry inspection for that slice by revoking it: AVAILABLE again.
  const r = risk.page;
  await openTab(r, t, "refund");
  await signAction(r, `revoke-${tr}`, "Prepare revocation", "Sign revocation");
  await openTab(r, t, "refund");
  await expect(card(r, ids["failTreasury"] as string)).toHaveAttribute("data-state", "REVOKED");
  await expect(bucket(r, info.accounts.treasury, "available")).toHaveAttribute(
    "data-yocto",
    (4n * NEAR).toString(),
  );
  // Only risk/policy may authorize, and the contract refuses before the 48-hour window.
  await openTab(b, t, "refund");
  await expect(b.getByTestId(`action-sauthorize-${slug(ids["failBuyer"] as string)}`)).toHaveCount(0);
  await expect(b.getByTestId(`action-authorize-${slug(ids["failBuyer"] as string)}`)).toHaveCount(0);
  await openTab(r, t, "refund");
  await signRefused(
    r,
    `sauthorize-${slug(ids["failBuyer"] as string)}`,
    "Prepare authorization",
    "Sign authorization",
    "DELAY_NOT_ELAPSED",
  );
  // The policy hold must be resolved before an authorization can pass: risk resolves to refund.
  await resolveToRefund(t, ids["failHold"] as string);
});

test("T-009 PERMANENT_HOLD: risk initiates after RESOLVE_TO_REFUND, the supplier consents; a second slice is revoked during cooling", async () => {
  test.setTimeout(300_000);
  const t = trades.hold;
  await completeEvidence(supplier.page, inspector.page, t);
  await inspect(inspector.page, t, "REVIEW", "SEAL_MISMATCH");
  const h = await holdId(risk.page, t);
  const r = risk.page;
  await openTab(r, t, "refund");
  await expect(candidate(r, info.accounts.buyer, "PERMANENT_HOLD")).toHaveAttribute(
    "data-blocked",
    "NOT_ELIGIBLE",
  );
  await resolveToRefund(t, h);
  // Neither trade party may initiate this row.
  await openTab(buyer.page, t, "refund");
  await expect(
    buyer.page.getByTestId(`action-refund-permanent-hold-${slug(info.accounts.buyer)}`),
  ).toHaveCount(0);
  ids["holdBuyer"] = await request(r, t, "PERMANENT_HOLD", info.accounts.buyer);
  const hb = slug(ids["holdBuyer"] as string);
  await expect(card(r, ids["holdBuyer"] as string)).toContainText(
    "Risk/policy: Signed; supplier signer: Not signed",
  );
  await expect(card(r, ids["holdBuyer"] as string)).toHaveAttribute("data-state", "REQUESTED");
  const s = supplier.page;
  await openTab(s, t, "refund");
  await signAction(s, `cosign-${hb}`, "Review the exact request", "Sign the identical request");
  await openTab(s, t, "refund");
  await expect(card(s, ids["holdBuyer"] as string)).toHaveAttribute("data-state", "TIMELOCKED");
  await expect(card(s, ids["holdBuyer"] as string)).toContainText(
    "Risk/policy: Signed; supplier signer: Signed",
  );
  await expect(s.getByTestId(`action-dispute-${hb}`)).toHaveCount(0);
  // The treasury slice: requested, consented, then revoked by the supplier during cooling.
  ids["holdTreasury"] = await request(r, t, "PERMANENT_HOLD", info.accounts.treasury);
  const ht = slug(ids["holdTreasury"] as string);
  await openTab(s, t, "refund");
  await signAction(s, `cosign-${ht}`, "Review the exact request", "Sign the identical request");
  await openTab(s, t, "refund");
  await signAction(s, `revoke-${ht}`, "Prepare revocation", "Sign revocation");
  await openTab(s, t, "refund");
  await expect(card(s, ids["holdTreasury"] as string)).toHaveAttribute("data-state", "REVOKED");
  await expect(bucket(s, info.accounts.treasury, "available")).toHaveAttribute(
    "data-yocto",
    (4n * NEAR).toString(),
  );
  await authorize(s, t, ids["holdBuyer"] as string, "DELAY_NOT_ELAPSED");
});

test("T-010 race: release-intent lock and mutual-cancel request submitted at once from two contexts; one lock wins", async () => {
  test.setTimeout(300_000);
  const t = trades.race;
  await completeEvidence(supplier.page, inspector.page, t);
  await inspectPass(inspector.page, t);
  const b = buyer.page;
  const s = supplier.page;
  // Buyer: prepare and sign the release intent; stop at the relay.
  await openTab(b, t, "release");
  await eventually(b, async () => {
    await b.reload();
    await waitForScreen(b);
    await expect(b.getByTestId("blockers")).not.toContainText("INSPECTION_NOT_PASS", { timeout: 2_000 });
  });
  const lock = b.getByTestId("action-lock");
  await lock.getByRole("button", { name: "Prepare release intent", exact: true }).click();
  await lock.getByTestId("review-lock").getByRole("button", { name: "Sign release intent" }).click();
  const lockSubmit = lock
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" });
  await expect(lockSubmit).toBeVisible();
  // Supplier: prepare and sign a mutual cancellation of the buyer's slice; stop at the relay.
  await openTab(s, t, "refund");
  const rid = `refund-mutual-cancel-${slug(info.accounts.buyer)}`;
  const rbox = s.getByTestId(`action-${rid}`);
  await rbox.getByRole("button", { name: "Prepare refund request", exact: true }).click();
  await rbox.getByTestId(`review-${rid}`).getByRole("button", { name: "Sign refund request" }).click();
  const refundSubmit = rbox
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" });
  await expect(refundSubmit).toBeVisible();
  // Both sessions submit at the same instant.
  const before = await balances();
  await Promise.all([lockSubmit.click(), refundSubmit.click()]);
  const lockText = await relayOutcome(lock, "lock");
  const refundText = await relayOutcome(rbox, rid);
  const accepted = [lockText, refundText].filter((x) => x.includes("Contract accepted"));
  expect(accepted, `${lockText} / ${refundText}`).toHaveLength(1);
  raceWinner = lockText.includes("Contract accepted") ? "RELEASE" : "REFUND";
  test.info().annotations.push({ type: "race-winner", description: raceWinner });
  // Recorded in the run log: which lock won this race.
  console.log(`RACE_WINNER ${raceWinner} lock="${lockText}" refund="${refundText}"`);
  if (raceWinner === "RELEASE") {
    // The refund request lost on the contract's value lock; nothing was requested.
    expect(refundText).toContain("VALUE_LOCKED");
    await openTab(s, t, "refund");
    await expect(s.locator('[data-testid="refund-intent"]')).toHaveCount(0);
    await expect(candidate(s, info.accounts.buyer, "MUTUAL_CANCEL")).toHaveAttribute(
      "data-blocked",
      "VALUE_LOCKED",
    );
    await openTab(b, t, "release");
    await eventually(b, async () => expect(b.getByTestId("action-approve")).toBeVisible());
    await signAction(b, "approve", "Prepare approval", "Sign approval");
    await openTab(b, t, "release");
    await eventually(b, async () => expect(b.getByTestId("execute-release")).toBeVisible());
    await b.getByRole("button", { name: "Execute direct release" }).click();
    await b
      .getByRole("dialog", { name: "Execute direct release" })
      .getByRole("button", { name: "Queue release" })
      .click();
    await openTab(b, t, "payout");
    await eventually(
      b,
      async () => expect(b.getByTestId("operation").first()).toHaveAttribute("data-state", "PAID"),
      90_000,
    );
    const after = await balances();
    expect((after[info.accounts.supplier] as bigint) - (before[info.accounts.supplier] as bigint)).toBe(
      10n * NEAR,
    );
    expect(after[info.accounts.buyer]).toBe(before[info.accounts.buyer]);
    await openTab(b, t, "refund");
    await expect(bucket(b, info.accounts.buyer, "released")).toHaveAttribute(
      "data-yocto",
      (10n * NEAR).toString(),
    );
    await expect(b.getByRole("button", { name: /Prepare refund request/ })).toHaveCount(0);
  } else {
    // The release intent lost: the slice is refund-locked; the buyer cosigns; it settles after the clock.
    expect(lockText).toMatch(/NOTHING_ELIGIBLE|VALUE_LOCKED|NOT_FULLY_FUNDED|INVALID_STATE/);
    await openTab(b, t, "refund");
    const mc = b.locator('[data-testid="refund-intent"][data-reason="MUTUAL_CANCEL"]');
    await expect(mc).toHaveCount(1);
    ids["race"] = (await mc.getAttribute("data-id")) ?? "";
    await signAction(
      b,
      `cosign-${slug(ids["race"])}`,
      "Review the exact request",
      "Sign the identical request",
    );
    await openTab(b, t, "release");
    await expect(b.getByTestId("action-approve")).toHaveCount(0);
    await expect(b.getByTestId("execute-release")).toHaveCount(0);
    expect(await balances()).toEqual(before);
  }
});

test("T-010 destination activation during a live refund: the contract refuses VALUE_LOCKED, then the API refuses, the destination stays", async () => {
  test.setTimeout(300_000);
  const t = trades.dest;
  const b = buyer.page;
  const s = supplier.page;
  const wait = consentedAt + 62_000 - Date.now();
  if (wait > 0) await b.waitForTimeout(wait);
  // The buyer prepares the activation while no refund exists: the API passes it to the relay.
  await openTab(b, t, "agreement");
  await b.getByRole("button", { name: "Activate destination revision" }).click();
  await b
    .getByRole("dialog", { name: "Activate destination revision" })
    .getByRole("button", { name: "Prepare activation" })
    .click();
  const act = b.getByTestId("destination-activation");
  const actSubmit = act
    .getByTestId("relay-panel")
    .getByRole("button", { name: "Submit to the escrow contract" });
  await expect(actSubmit).toBeVisible();
  // Meanwhile the supplier's mutual cancellation becomes a live refund on the contract.
  ids["dest"] = await request(s, t, "MUTUAL_CANCEL", info.accounts.buyer);
  await expect(card(s, ids["dest"])).toHaveAttribute("data-state", "REQUESTED");
  await actSubmit.click();
  await expect(act.getByTestId("relay-status")).toContainText("VALUE_LOCKED");
  await expect(act.getByTestId("destination-bound")).toHaveText("");
  // A fresh preparation is refused by the API itself.
  await openTab(b, t, "agreement");
  await b.getByRole("button", { name: "Activate destination revision" }).click();
  await b
    .getByRole("dialog", { name: "Activate destination revision" })
    .getByRole("button", { name: "Prepare activation" })
    .click();
  await expect(b.getByTestId("destination-activation")).toContainText("VALUE_LOCKED");
  await expect(b.getByTestId("destination-activation").getByTestId("relay-panel")).toHaveCount(0);
  await openTab(b, t, "agreement");
  await expect(b.getByTestId("agreement-facts")).toContainText("revision r1");
  await expect(b.getByTestId("destination-pending")).toHaveAttribute("data-status", "CONSENTED");
  // The buyer cosigns the cancellation; it settles on the contract clock below.
  await openTab(b, t, "refund");
  await signAction(
    b,
    `cosign-${slug(ids["dest"])}`,
    "Review the exact request",
    "Sign the identical request",
  );
  await openTab(b, t, "refund");
  await expect(card(b, ids["dest"])).toHaveAttribute("data-state", "TIMELOCKED");
});

test("T-009 TRADE_EXPIRY on the contract clock: chain +25 h; buyer request timelocked, supplier's request disputed into REVIEW", async () => {
  test.setTimeout(300_000);
  const t = trades.expiry;
  const b = buyer.page;
  const s = supplier.page;
  await chainAhead(25 * HOUR);
  await openTab(b, t, "refund");
  await expect(candidate(b, info.accounts.buyer, "TRADE_EXPIRY")).toHaveAttribute("data-blocked", "");
  ids["expiryBuyer"] = await request(b, t, "TRADE_EXPIRY", info.accounts.buyer);
  const c = card(b, ids["expiryBuyer"] as string);
  await expect(c).toHaveAttribute("data-state", "TIMELOCKED");
  await expect(c).toContainText("Initiator");
  ids["expiryTreasury"] = await request(s, t, "TRADE_EXPIRY", info.accounts.treasury);
  const tr = slug(ids["expiryTreasury"] as string);
  // Only the initiator may revoke: the buyer holds no revocation for the supplier's request.
  await openTab(b, t, "refund");
  await expect(b.getByTestId(`action-revoke-${tr}`)).toHaveCount(0);
  const box = b.getByTestId(`action-dispute-${tr}`);
  await box.getByLabel("Dispute reason code").fill("GOODS_SHIPPED");
  await box
    .getByLabel("Dispute statement")
    .fill("Bill of lading issued before expiry; disputing the expiry refund.");
  await signAction(b, `dispute-${tr}`, "Prepare dispute", "Sign dispute");
  await openTab(b, t, "refund");
  await expect(card(b, ids["expiryTreasury"] as string)).toHaveAttribute("data-state", "REVIEW");
  await expect(card(b, ids["expiryTreasury"] as string).getByTestId("refund-locked")).toContainText(
    "BUYER dispute paused it",
  );
  expect(await b.content()).not.toContain("Bill of lading issued");
  // The 24-hour challenge is still running on the contract.
  await authorize(s, t, ids["expiryBuyer"] as string, "DELAY_NOT_ELAPSED");
  for (const vp of VIEWPORTS) {
    await b.setViewportSize({ width: vp.width, height: vp.height });
    await openTab(b, t, "refund");
    await expectNoBodyOverflow(b, `trade-expiry timelocked and review @${vp.name}`);
    await expectAccessible(b, `trade-expiry timelocked and review @${vp.name}`);
  }
  await b.setViewportSize({ width: 1280, height: 900 });
});

test("T-009/T-010 chain +24 h: every reason authorizes and refunds its original funder exactly once", async () => {
  test.setTimeout(300_000);
  const b = buyer.page;
  const s = supplier.page;
  const r = risk.page;
  await chainAhead(24 * HOUR);
  const before = await balances();
  // INSPECTION_FAIL: the separate risk/policy signed authorization, now after the appeal window.
  await openTab(r, trades.fail, "refund");
  await signAction(
    r,
    `sauthorize-${slug(ids["failBuyer"] as string)}`,
    "Prepare authorization",
    "Sign authorization",
  );
  await waitState(r, trades.fail, ids["failBuyer"] as string, "AUTHORIZED");
  // TRADE_EXPIRY and PERMANENT_HOLD: permissionless relays the contract judges on its own clock.
  await authorize(s, trades.expiry, ids["expiryBuyer"] as string, null);
  await authorize(b, trades.hold, ids["holdBuyer"] as string, null);
  await authorize(s, trades.dest, ids["dest"] as string, null);
  const expected: [string, string, bigint][] = [
    [trades.fail, ids["failBuyer"] as string, 6n],
    [trades.expiry, ids["expiryBuyer"] as string, 6n],
    [trades.hold, ids["holdBuyer"] as string, 6n],
    [trades.dest, ids["dest"] as string, 10n],
  ];
  if (raceWinner === "REFUND") {
    await authorize(b, trades.race, ids["race"] as string, null);
    expected.push([trades.race, ids["race"] as string, 10n]);
  }
  for (const [t, rid, near] of expected) await execute(b, t, rid, info.accounts.buyer, near);
  for (const [t, rid, near] of expected) {
    await waitState(b, t, rid, "REFUNDED", 90_000);
    await expect(card(b, rid)).toContainText("Refunded to the original funder");
    await expect(bucket(b, info.accounts.buyer, "refunded")).toHaveAttribute(
      "data-yocto",
      (near * NEAR).toString(),
    );
    await expect(b.getByTestId("refund-operations").getByTestId("operation")).toHaveCount(1);
    await expect(b.getByTestId("refund-operations").getByTestId("operation").first()).toHaveAttribute(
      "data-state",
      "REFUNDED",
    );
  }
  // The chain's own balances: each refund moved exactly once, only to the original funder.
  const after = await balances();
  const total = expected.reduce((a, [, , n]) => a + n * NEAR, 0n);
  expect((after[info.accounts.buyer] as bigint) - (before[info.accounts.buyer] as bigint)).toBe(total);
  expect(after[info.accounts.treasury]).toBe(before[info.accounts.treasury]);
  expect(after[info.accounts.supplier]).toBe(before[info.accounts.supplier]);
  expect(after[info.accounts.supplierAlt]).toBe(start[info.accounts.supplierAlt]);
  // The disputed and revoked slices stayed where the contract put them.
  await openTab(b, trades.expiry, "refund");
  await expect(card(b, ids["expiryTreasury"] as string)).toHaveAttribute("data-state", "REVIEW");
  await expect(bucket(b, info.accounts.treasury, "refundLocked")).toHaveAttribute(
    "data-yocto",
    (4n * NEAR).toString(),
  );
  for (const t of [trades.fail, trades.hold]) {
    await openTab(b, t, "refund");
    await expect(bucket(b, info.accounts.treasury, "refunded")).toHaveAttribute("data-yocto", "0");
  }
  await openTab(b, trades.fail, "timeline");
  for (const e of [
    "REFUND_REQUEST_SIGNED",
    "REFUND_DISPUTE_SIGNED",
    "REFUND_REVOCATION_SIGNED",
    "REFUND_AUTHORIZATION_SIGNED",
    "REFUND_EXECUTION_REQUESTED",
  ])
    await expect(b.getByTestId("timeline-table")).toContainText(e);
});

test("T-010 after the refund settled, activation is still refused (INVALID_STATE) and the payout destination never changed", async () => {
  test.setTimeout(180_000);
  const b = buyer.page;
  const t = trades.dest;
  await openTab(b, t, "agreement");
  await b.getByRole("button", { name: "Activate destination revision" }).click();
  await b
    .getByRole("dialog", { name: "Activate destination revision" })
    .getByRole("button", { name: "Prepare activation" })
    .click();
  const act = b.getByTestId("destination-activation");
  await act.getByTestId("relay-panel").getByRole("button", { name: "Submit to the escrow contract" }).click();
  await expect(act.getByTestId("relay-status")).toContainText("INVALID_STATE");
  await openTab(b, t, "agreement");
  await expect(b.getByTestId("agreement-facts")).toContainText("revision r1");
  await expect(b.getByTestId("agreement-facts")).toContainText(info.accounts.supplier);
  const after = await balances();
  expect(after[info.accounts.supplierAlt]).toBe(start[info.accounts.supplierAlt]);
  await openTab(b, t, "refund");
  await expectAccessible(b, "refunded after a refused activation");
});
