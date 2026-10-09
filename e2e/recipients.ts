import { expect, type Page } from '@playwright/test';

export async function acceptInvitation(page: Page, url: string, persona: string, space: string) {
  await page.goto(url);
  const picker = page.getByRole('link', { name: new RegExp(persona) });
  const current = page.getByRole('button', { name: `Spaces, current: ${space}`, exact: true });
  await expect(picker.or(current)).toBeVisible();
  if (await picker.isVisible()) await picker.click();
  await expect(current).toBeVisible();
}
