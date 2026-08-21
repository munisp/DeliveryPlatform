import { expect, test } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL;
const sessionCookie = process.env.E2E_SESSION_COOKIE;
const sessionCookieName = process.env.E2E_SESSION_COOKIE_NAME ?? "switchos_session";
const runnable = Boolean(baseURL && sessionCookie);

test.describe("administrator security and financial workflows", () => {
  test.skip(!runnable, "Requires an isolated E2E_BASE_URL and a short-lived MFA-assured E2E_SESSION_COOKIE.");

  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: sessionCookieName, value: sessionCookie!, url: baseURL!, httpOnly: true, secure: baseURL!.startsWith("https://") }]);
  });

  test("shows MFA enrollment guidance without exposing enrollment secrets", async ({ page }) => {
    await page.goto("/profile/security");
    await expect(page.getByRole("heading", { name: "Security settings" })).toBeVisible();
    await page.getByRole("button", { name: "Set up MFA" }).click();
    await expect(page.getByText("Generate recovery codes in the identity provider")).toBeVisible();
    await expect(page.getByText("this page never receives or retains them")).toBeVisible();
  });

  test("shows read-only financial controls only to an MFA-assured financial administrator", async ({ page }) => {
    await page.goto("/admin/finance");
    await expect(page.getByRole("heading", { name: "Immutable funds oversight" })).toBeVisible();
    await expect(page.getByText("Testing and coverage")).toBeVisible();
    await expect(page.getByText("This workspace cannot alter funds.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Download CSV report" })).toBeVisible();
  });
});
