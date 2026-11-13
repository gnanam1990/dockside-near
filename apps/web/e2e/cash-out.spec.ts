/**
 * M52 supplier cash-out ("Move to another chain") in the browser, against the real API process on
 * the local stack (SIMULATED NEAR chain and token) and the local 1Click simulator.
 *
 * The supplier previews a dry quote in the web app. This test then plays the two things that
 * belong to the supplier and never to Dockside: the supplier's own client (it sends the real quote
 * request, exactly as shown, straight to the simulator) and the supplier's own wallet (it signs the
 * deposit on the simulated chain through the stack's supplier-wallet control). The web app turns
 * the pasted quote into one wallet call and then tracks the cash-out through a failed deposit, a
 * deposit 1Click has not noticed yet, a 1Click outage and delivery, without ever offering a blind
 * resend. SIMULATED: 1Click, the chain and the token. No testnet, mainnet or 1Click request.
 */
import { expect, type Page, test } from "@playwright/test";
import { createTrade, type StackInfo } from "./flows";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, openTab, type Person } from "./stack";

test.describe.configure({ mode: "serial" });

const SIM = process.env["DOCKSIDE_E2E_ONE_CLICK_SIM_URL"] ?? "http://127.0.0.1:9024";
const ARB_USDC = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

let buyer: Person;
let supplier: Person;
let inspector: Person;
let risk: Person;
let info: StackInfo;
let tradeId = "";
let depositAddress = "";

async function sim<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(SIM + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json()) as T;
  if (!r.ok) throw new Error(`simulator ${path}: ${JSON.stringify(j)}`);
  return j;
}

const tokenState = () =>
  control<{ token: string; balances: Record<string, string>; registered: string[] }>("/control/token");

const codeOf = async (page: Page, testId: string, nth = 0) =>
  (await page.getByTestId(testId).locator("code.address__value").nth(nth).innerText()).trim();

async function readStatus(page: Page, state: string, hash?: string): Promise<void> {
  const box = page.getByTestId("cash-out-tracking");
  if (hash !== undefined)
    await box.getByLabel("Your deposit transaction hash (after you sent it)").fill(hash);
  await box.getByRole("button", { name: "Read status" }).click();
  await expect(box.getByTestId("cash-out-status")).toHaveAttribute("data-state", state);
}

test.beforeAll(async ({ browser }) => {
  info = await control<StackInfo>("/control/info");
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Bea Buyer");
  risk = await enroll(browser, "buyer", "RISK_RESOLVER", "Rob Risk");
  supplier = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Suki Supplier");
  inspector = await enroll(browser, "inspector", "INSPECTOR", "Ian Inspector");
  tradeId = await createTrade(
    info,
    { buyer, supplier, inspector, risk },
    { milestone: "cash-out-1", amountNear: "10" },
  );
});

test.afterAll(async () => {
  for (const p of [buyer, supplier, inspector, risk]) await p?.ctx.close();
});

test("the buyer sees what the panel is, and none of its controls", async () => {
  await openTab(buyer.page, tradeId, "payout");
  const box = buyer.page.getByTestId("cash-out");
  await expect(box.getByTestId("cash-out-not-supplier")).toContainText("Shown to the supplier signer only");
  await expect(box.getByRole("button")).toHaveCount(0);
  await expect(buyer.page.getByTestId("cash-out-form")).toHaveCount(0);
});

test("the supplier previews a dry quote: amount out, fee and deadline, nothing committed", async () => {
  const s = supplier.page;
  await openTab(s, tradeId, "payout");
  const box = s.getByTestId("cash-out");
  await expect(box).toContainText(info.accounts.supplier);
  await expect(box.getByTestId("cash-out-preview-only")).toHaveCount(0);

  // Input errors are shown in place and nothing is asked of 1Click.
  await box.getByRole("button", { name: "Get a dry quote" }).click();
  await expect(box).toContainText("Enter a plain number");
  await expect(box).toContainText("Choose the destination chain");
  await expect(box).toContainText("Enter the destination address exactly");

  await box.getByLabel("Amount to send (SIMUSD)").fill("2");
  await box.getByLabel("Destination chain").selectOption("arb");
  await box.getByLabel("Token to receive").selectOption(ARB_USDC);
  await box.getByLabel("Destination address").fill(RECIPIENT);
  await box.getByRole("button", { name: "Get a dry quote" }).click();

  const quote = s.getByTestId("cash-out-quote");
  await expect(quote).toContainText("2 SIMUSD");
  await expect(quote).toContainText("1.944 USDC on arb");
  await expect(quote).toContainText("1.92456 USDC (1.00% slippage)");
  await expect(quote).toContainText("0.056 USD (2.80% of the amount sent)");
  await expect(quote).toContainText("0.05 USDC");
  await expect(quote).toContainText("45 seconds after the deposit");
  await expect(quote).toContainText(/Deadline\s*20\d\d-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
  await expect(quote).toContainText("Committed: nothing");

  // Everything Dockside sent to 1Click so far was a read or a dry quote.
  const requests =
    await sim<{ method: string; path: string; body: { dry?: boolean } | null }[]>("/__sim/requests");
  const quotes = requests.filter((r) => r.path === "/v0/quote");
  expect(quotes.length).toBe(1);
  expect(quotes.every((r) => r.body?.dry === true)).toBe(true);
});

test("the supplier's own real quote becomes one wallet call; a different quote is refused", async () => {
  const s = supplier.page;
  const step = s.getByTestId("cash-out-real-quote");
  const request = JSON.parse(await codeOf(s, "cash-out-real-quote", 0)) as Record<string, unknown>;
  expect(request).toMatchObject({
    dry: false,
    refundTo: info.accounts.supplier,
    recipient: RECIPIENT,
    amount: "2000000",
    originAsset: `nep141:${(await tokenState()).token}`,
    destinationAsset: ARB_USDC,
  });
  expect(await codeOf(s, "cash-out-real-quote", 1)).toContain(
    `Invoke-RestMethod -Method Post -Uri '${SIM}/v0/quote'`,
  );

  // The supplier's own client asks 1Click. First paste an answer for another recipient.
  const other = await sim<Record<string, unknown>>("/v0/quote", {
    ...request,
    recipient: "0x2222222222222222222222222222222222222222",
  });
  await step.getByLabel("1Click's answer to your request").fill(JSON.stringify(other));
  await step.getByRole("button", { name: "Check the quote and build the deposit call" }).click();
  await expect(s.getByTestId("cash-out-quote-mismatch")).toContainText("recipient");
  await expect(s.getByTestId("cash-out-deposit")).toHaveCount(0);

  await step.getByLabel("1Click's answer to your request").fill("not json");
  await step.getByRole("button", { name: "Check the quote and build the deposit call" }).click();
  await expect(step).toContainText("That is not JSON");

  const real = await sim<{ quote: { depositAddress: string } }>("/v0/quote", request);
  depositAddress = real.quote.depositAddress;
  await step.getByLabel("1Click's answer to your request").fill(JSON.stringify(real, null, 2));
  await step.getByRole("button", { name: "Check the quote and build the deposit call" }).click();

  const dep = s.getByTestId("cash-out-deposit");
  await expect(dep).toContainText("Dockside does not send it");
  await expect(dep).toContainText(depositAddress);
  await expect(dep).toContainText("ft_transfer");
  const call = JSON.parse(await codeOf(s, "cash-out-deposit", 0));
  expect(call).toEqual({
    receiverId: (await tokenState()).token,
    methodName: "ft_transfer",
    args: { receiver_id: depositAddress, amount: "2000000" },
    gas: "30000000000000",
    depositYocto: "1",
  });
  expect(await codeOf(s, "cash-out-deposit", 1)).toContain(
    `sign-as ${info.accounts.supplier} network-config testnet sign-with-keychain send`,
  );
  // Still nothing moved, and Dockside still never asked for a real quote.
  const requests =
    await sim<{ path: string; body: { dry?: boolean } | null; authorization: string | null }[]>(
      "/__sim/requests",
    );
  // The two real quotes above came from this test (the supplier's own client), not from the API:
  // the API's only quote request is the dry one.
  expect(requests.filter((r) => r.path === "/v0/quote" && r.body?.dry === false).length).toBe(2);
  expect((await tokenState()).balances[depositAddress]).toBeUndefined();

  for (const v of VIEWPORTS) {
    await s.setViewportSize({ width: v.width, height: v.height });
    await expectNoBodyOverflow(s, `cash-out ${v.name}`);
  }
  await s.setViewportSize({ width: 1440, height: 900 });
  await expectAccessible(s, "payout tab with the cash-out panel");
});

test("tracking reconciles 1Click with the chain and never offers a blind resend", async () => {
  test.setTimeout(180_000);
  const s = supplier.page;
  const box = s.getByTestId("cash-out-tracking");
  await expect(box.getByLabel("1Click deposit address")).toHaveValue(depositAddress);
  const call = JSON.parse(await codeOf(s, "cash-out-deposit", 0));
  const before = BigInt((await tokenState()).balances[info.accounts.supplier] ?? "0");

  // Nothing sent: one deposit may be sent, and the same call is shown.
  await readStatus(s, "AWAITING_DEPOSIT");
  await expect(box).toContainText("Yes, once");
  expect(JSON.parse(await codeOf(s, "cash-out-status-call", 0))).toEqual(call);

  // The supplier's wallet sends it; the token refuses (deposit address not registered yet).
  const failed = await control<{ txHash: string; outcome: string }>("/control/supplier-wallet-call", {
    call,
  });
  expect(failed.outcome).toBe("FINAL_FAILURE");
  await readStatus(s, "DEPOSIT_FAILED_NO_TRANSFER", failed.txHash);
  await expect(box.getByTestId("cash-out-reason")).toContainText("nothing moved");
  await expect(box.getByTestId("cash-out-status-call")).toBeVisible();

  // Second attempt succeeds on chain. 1Click has not noticed: do not send again.
  await control("/control/token-faults", { register: depositAddress });
  const sent = await control<{ txHash: string; outcome: string }>("/control/supplier-wallet-call", { call });
  expect(sent.outcome).toBe("FINAL_SUCCESS");
  await readStatus(s, "DEPOSIT_SENT_WAITING_FOR_PROVIDER", sent.txHash);
  await expect(box.getByTestId("cash-out-reason")).toContainText("Do not send the deposit again");
  await expect(box.getByTestId("cash-out-status-call")).toHaveCount(0);
  // The old failed hash proves nothing now: the deposit address already holds the token.
  await readStatus(s, "DEPOSIT_SENT_WAITING_FOR_PROVIDER", failed.txHash);
  await expect(box.getByTestId("cash-out-status-call")).toHaveCount(0);

  // 1Click stops answering: UNKNOWN, and still no call to send.
  await sim("/__sim/fault", { fault: "http500" });
  await readStatus(s, "UNKNOWN", sent.txHash);
  await expect(box).toContainText("State unknown: do not send the deposit again");
  await expect(box.getByTestId("cash-out-status-call")).toHaveCount(0);
  await sim("/__sim/fault", { fault: "none" });

  // 1Click picks the deposit up, executes and delivers.
  await sim("/__sim/observe-deposit", { depositAddress, amount: "2000000", txHash: sent.txHash });
  await readStatus(s, "IN_PROGRESS");
  await sim("/__sim/settle", { depositAddress, destinationTxHash: "0xdeliveredonarbitrum" });
  await readStatus(s, "DELIVERED");
  await expect(box).toContainText("0xdeliveredonarbitrum");
  await expect(box).toContainText(`1.944 to ${RECIPIENT}`);
  await expect(box.getByTestId("cash-out-status-call")).toHaveCount(0);

  // Exactly one deposit left the supplier's account.
  const after = await tokenState();
  expect(BigInt(after.balances[info.accounts.supplier] ?? "0")).toBe(before - 2_000_000n);
  expect(after.balances[depositAddress]).toBe("2000000");

  // The tracked deposit address survives a reload; the state is recomputed, not remembered.
  await s.reload();
  await waitForScreen(s);
  const again = s.getByTestId("cash-out-tracking");
  await expect(again.getByLabel("1Click deposit address")).toHaveValue(depositAddress);
  await readStatus(s, "DELIVERED");
  await expectAccessible(s, "payout tab with a delivered cash-out");
});
