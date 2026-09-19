import { expect, type Page } from "@playwright/test";

export async function openIntel(page: Page) {
  const trigger = page.getByTestId("open-intel");
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(page.getByTestId("intel-drawer")).toBeVisible();
}
export async function openAdvisor(page: Page) {
  const trigger = page.getByTestId("open-advisor");
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(page.getByTestId("advisor-drawer")).toBeVisible();
}
export async function openMission(page: Page) {
  if ((await page.locator(".mission-details").getAttribute("open")) === null)
    await page.getByTestId("open-mission").click();
}
export async function closeMission(page: Page) {
  if ((await page.locator(".mission-details").getAttribute("open")) !== null)
    await page.getByTestId("open-mission").click();
}
export async function openDecisionNotes(page: Page) {
  const details = page.locator(".decision-notes");
  if ((await details.getAttribute("open")) === null)
    await details.locator(":scope > summary").click();
}
