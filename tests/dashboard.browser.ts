import { test, expect } from "@playwright/test";

const key = "dashboard-browser-test-only";

test("dashboard opens without a key, copies the Worker pairing key, and revokes a device", async ({
  page,
  request,
  context,
}) => {
  const vault = `browser-${crypto.randomUUID()}`;
  const device = crypto.randomUUID();
  const name = '<img src=x onerror="window.compromised=true">';
  const headers = { Authorization: `Bearer ${key}`, "X-Vault-Id": vault };
  const response = await request.post("/devices/enroll", {
    headers,
    data: { deviceId: device, name, platform: "browser-test" },
  });
  expect(response.ok()).toBe(true);
  const { deviceToken } = await response.json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  expect(errors).toEqual([]);
  await expect(page.getByRole("heading", { name: "default", exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Copy pairing key" }).click();
  await expect(page.getByRole("status")).toHaveText("Pairing key copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  await page.getByLabel("Vault ID", { exact: true }).fill(vault);
  await page.getByRole("button", { name: "Open vault" }).click();
  await expect(page.getByRole("heading", { name: vault, exact: true })).toBeVisible();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText("No progress report", { exact: true })).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);
  await page.getByRole("button", { name: "Copy pairing key" }).click();
  await expect(page.getByRole("status")).toHaveText("Pairing key copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(await page.content()).not.toContain(key);
  const progress = await request.post("/sync/status", {
    headers: { ...headers, Authorization: `Bearer ${deviceToken}`, "X-Device-Id": device },
    data: { globalVersion: 0, pendingOperations: 0, state: "active" },
  });
  expect(progress.ok()).toBe(true);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Applied through 0 · 0 changes behind", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("dashboard-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("dashboard-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("cell", { name: "Revoked", exact: true })).toBeVisible();
  const rejected = await request.get("/sync/index", {
    headers: { ...headers, Authorization: `Bearer ${deviceToken}`, "X-Device-Id": device },
  });
  expect(rejected.status()).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { name: "default", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
