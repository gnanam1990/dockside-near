/**
 * M17 NEP-413 wallet connector and NEAR account ownership in the browser, against the real API and
 * the SIMULATED chain of the local stack.
 *
 * The test wallet is a page-announced connector (`near-wallet:announce`) whose signMessage is
 * answered by this test process: it holds an Ed25519 key generated here and signs the real NEP-413
 * payload with its own Borsh serialisation (independent of the product code). The account's access
 * keys on the simulated chain are added and deleted through the stack's control port, standing in
 * for the account's own AddKey/DeleteKey transactions. The server verifies the signature and asks the
 * chain adapter `view_access_key` for a full-access key; the browser checks the wallet's answer first.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectAccessible, expectNoBodyOverflow, VIEWPORTS, waitForScreen } from "./helpers";
import { control, enroll, type Person } from "./stack";

test.describe.configure({ mode: "serial" });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

/** The wallet side: its own key and its own NEP-413 Borsh encoding. */
class TestWallet {
  private readonly key: KeyObject;
  readonly publicKey: string;
  /** What the wallet claims as its account; a test can make it lie. */
  accountId: string;
  signed = 0;
  constructor(accountId: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.key = privateKey;
    const x = publicKey.export({ format: "jwk" }).x as string;
    this.publicKey = `ed25519:${base58(new Uint8Array(Buffer.from(x, "base64url")))}`;
    this.accountId = accountId;
  }
  sign(r: { message: string; nonceHex: string; recipient: string }) {
    const u32 = (v: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v >>> 0, 0);
      return b;
    };
    const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s, "utf8")), Buffer.from(s, "utf8")]);
    const payload = Buffer.concat([
      u32(2 ** 31 + 413),
      str(r.message),
      Buffer.from(r.nonceHex, "hex"),
      str(r.recipient),
      Buffer.from([0]),
    ]);
    this.signed++;
    return {
      accountId: this.accountId,
      publicKey: this.publicKey,
      signature: sign(null, createHash("sha256").update(payload).digest(), this.key).toString("base64"),
    };
  }
}

async function installWallet(ctx: BrowserContext, wallet: { current: TestWallet }): Promise<void> {
  await ctx.exposeBinding(
    "__docksideTestWalletSign",
    (_src, r: { message: string; nonceHex: string; recipient: string }) => wallet.current.sign(r),
  );
  await ctx.addInitScript(() => {
    const w = window as unknown as {
      __docksideTestWalletSign(r: { message: string; nonceHex: string; recipient: string }): Promise<unknown>;
    };
    const connector = {
      id: "dockside-test-wallet",
      name: "Test wallet (browser tests)",
      signMessage: (r: { message: string; nonce: Uint8Array; recipient: string }) =>
        w.__docksideTestWalletSign({
          message: r.message,
          nonceHex: Array.from(r.nonce, (b) => b.toString(16).padStart(2, "0")).join(""),
          recipient: r.recipient,
        }),
    };
    window.addEventListener("near-wallet:request", () =>
      window.dispatchEvent(new CustomEvent("near-wallet:announce", { detail: connector })),
    );
  });
}

let buyer: Person;
let admin: Person;
let plain: Person;
const ACCOUNT = "acme-treasury-m17.testnet";
const wallet = { current: new TestWallet(ACCOUNT) };

test.beforeAll(async ({ browser }) => {
  buyer = await enroll(browser, "buyer", "BUYER_APPROVER", "Acme wallet buyer");
  await installWallet(buyer.ctx, wallet);
  admin = await enroll(browser, "buyer", "ORG_SECURITY_ADMIN", "Acme wallet administrator");
  plain = await enroll(browser, "supplier", "SUPPLIER_SIGNER", "Harbor no-wallet signer");
});
test.afterAll(async () => {
  for (const p of [buyer, admin, plain]) await p?.ctx.close();
});

async function go(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForScreen(page);
}

async function attempt(page: Page, account: string): Promise<void> {
  const panel = page.getByTestId("near-link-panel");
  await panel.getByLabel("NEAR account ID").fill(account);
  await panel.getByRole("button", { name: "Request signing message" }).click();
  const review = page.getByTestId("near-challenge-review");
  await expect(review).toContainText(account);
  await expect(review).toContainText(new URL(page.url()).origin);
  await review.getByRole("button", { name: /^Sign with / }).click();
}

test("M17 without a wallet the connector says so and offers no signing", async () => {
  await go(plain.page, "/organization/near-accounts");
  await expect(plain.page.getByTestId("no-wallet")).toContainText("No NEAR wallet detected");
  await expect(plain.page.getByRole("button", { name: "Request signing message" })).toBeDisabled();
  await expectAccessible(plain.page, "near accounts without wallet");
});

test("M17 T-004 a real NEP-413 wallet signature links the account only when the key is a full-access key on chain", async () => {
  const p = buyer.page;
  await go(p, "/organization/near-accounts");
  await expect(p.getByLabel("Wallet")).toHaveValue("dockside-test-wallet");
  await expectAccessible(p, "near accounts with wallet");

  // 1. The key is not an access key of the account yet.
  await attempt(p, ACCOUNT);
  await expect(p.getByTestId("near-link-failure")).toContainText("ACCESS_KEY_NOT_FOUND");
  expect(wallet.current.signed).toBe(1);

  // 2. A function-call key does not prove ownership.
  await control("/control/access-keys", {
    accountId: ACCOUNT,
    publicKey: wallet.current.publicKey,
    permission: "FunctionCall",
  });
  await attempt(p, ACCOUNT);
  await expect(p.getByTestId("near-link-failure")).toContainText("ACCESS_KEY_NOT_FULL_ACCESS");

  // 3. Full access: linked, with the observed block.
  const added = await control<{ blockHeight: number }>("/control/access-keys", {
    accountId: ACCOUNT,
    publicKey: wallet.current.publicKey,
    permission: "FullAccess",
  });
  await attempt(p, ACCOUNT);
  await expect(p.getByTestId("near-linked")).toContainText(`${ACCOUNT} linked`);
  await expect(p.getByTestId("near-linked")).toContainText(wallet.current.publicKey);
  const row = p.getByTestId(`link-${ACCOUNT}`);
  await expect(row).toContainText("Full-access key on chain");
  const height = Number((await row.locator("td").nth(3).innerText()).trim());
  expect(height).toBeGreaterThanOrEqual(added.blockHeight);
  await expectAccessible(p, "near account linked");
});

test("M17 the browser refuses a wallet answer for another account; the server refuses another key", async () => {
  const p = buyer.page;
  await go(p, "/organization/near-accounts");
  // A wallet that answers for a different account is caught before anything is sent.
  wallet.current.accountId = "someone-else.testnet";
  const before = wallet.current.signed;
  await attempt(p, ACCOUNT);
  await expect(p.getByTestId("near-link-failure")).toContainText("Not sent to the server");
  expect(wallet.current.signed).toBe(before + 1);
  wallet.current.accountId = ACCOUNT;
  // A different wallet key that the account does not hold is refused by the chain check.
  const original = wallet.current;
  wallet.current = new TestWallet(ACCOUNT);
  await attempt(p, ACCOUNT);
  await expect(p.getByTestId("near-link-failure")).toContainText("ACCESS_KEY_NOT_FOUND");
  wallet.current = original;
});

test("M17 re-check after the key is deleted on chain shows it is no longer owned; the administrator sees the link", async () => {
  const p = buyer.page;
  await control("/control/access-keys", {
    accountId: ACCOUNT,
    publicKey: wallet.current.publicKey,
    delete: true,
  });
  await go(p, "/organization/near-accounts");
  await p.getByRole("button", { name: `Re-check ${ACCOUNT}` }).click();
  await expect(p.getByTestId("recheck-result")).toContainText("no longer an access key");
  await expect(p.getByTestId(`link-${ACCOUNT}`)).toContainText("Key not on account");
  // The link is an identity fact only: the buyer's capabilities did not change.
  await go(p, "/organization");
  await expect(p.getByTestId("me-panel")).toContainText("Buyer Approver");

  await go(admin.page, "/organization/near-accounts");
  await expect(admin.page.getByTestId("org-near-links")).toContainText(ACCOUNT);
  await expect(admin.page.getByTestId("org-near-links")).toContainText("Key not on account");
  for (const vp of VIEWPORTS) {
    await p.setViewportSize({ width: vp.width, height: vp.height });
    await go(p, "/organization/near-accounts");
    await expectNoBodyOverflow(p, `near accounts @${vp.name}`);
    await expectAccessible(p, `near accounts @${vp.name}`);
  }
});
