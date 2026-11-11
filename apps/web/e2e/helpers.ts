import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const VIEWPORTS = [
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
] as const;

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function expectAccessible(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary ?? ""}`),
  }));
  expect(summary, `axe violations on ${label}`).toEqual([]);
}

export async function expectNoBodyOverflow(page: Page, label: string): Promise<void> {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(o.scroll, `horizontal body overflow on ${label}`).toBeLessThanOrEqual(o.client);
}

export async function waitForScreen(page: Page): Promise<void> {
  await expect(page.locator("main h1").first()).toBeVisible();
  await expect(page.locator('[data-testid="state-loading"]')).toHaveCount(0);
  await expect(page.getByTestId("connection-status")).not.toHaveAttribute("data-status", "CONNECTING");
  // Let 120-200 ms colour transitions finish so contrast is measured on final colours.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
}

/** Creates a real organization through the UI and the real API; returns the principal ID. */
export async function bootstrapOrganization(page: Page, name: string): Promise<string> {
  await page.goto("/sign-in");
  await waitForScreen(page);
  await page.getByLabel("Organization name").fill(name);
  await page.getByRole("button", { name: "Request bootstrap challenge" }).click();
  const review = page.getByTestId("challenge-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("ORG_BOOTSTRAP");
  await expect(review).toContainText(name);
  await page.getByRole("button", { name: "Sign with this device key" }).click();
  await expect(page).toHaveURL(/\/organization$/);
  const panel = page.getByTestId("me-panel");
  await expect(panel).toBeVisible();
  const principal = await panel
    .locator("dt", { hasText: /^Principal$/ })
    .locator("xpath=following-sibling::dd")
    .innerText();
  expect(principal).toMatch(/^prn_[0-9a-f]{32}$/);
  return principal;
}
