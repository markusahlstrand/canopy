import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: /Local Owner/ }).click();
  await expect(page.getByRole('button', { name: 'Spaces, current: Acceptance Drive' })).toBeVisible();
}
export async function nav(page: Page, name: string) {
  if (page.viewportSize()!.width < 768) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name, exact: true }).click();
}
export async function createFolder(page: Page, name: string) {
  if (page.viewportSize()!.width < 768) {
    await page.getByRole('button', { name: 'Open navigation' }).click();
  }
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await dialog.getByRole('textbox').fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await revealRow(page, name);
}
export async function revealRow(page: Page, name: string) {
  const row = page.getByRole('button', { name: `Actions for ${name}`, exact: true });
  // Shared acceptance runs naturally outgrow the first real listing page.
  for (let count = 0; count < 100 && !await row.isVisible(); count++) {
    const more = page.getByRole('button', { name: /^Load more (folders|files)$/ }).first();
    if (!await more.isVisible()) break;
    await more.click();
    await expect.poll(async () => await row.isVisible() ||
      await page.getByRole('button', { name: /^Loading (folders|files)…$/ }).count() === 0).toBe(true);
  }
  await expect(row).toBeVisible();
}
export async function action(page: Page, name: string, action: string) {
  await revealRow(page, name);
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
export async function rename(page: Page, name: string, next: string, folder = false) {
  await action(page, name, 'Rename');
  const dialog = page.getByRole('dialog', { name: folder ? 'Rename folder' : 'Rename file' });
  await dialog.getByRole('textbox').fill(next);
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `Actions for ${next}`, exact: true })).toBeVisible();
}
export async function upload(page: Page, name: string, content: string) {
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await revealRow(page, name);
}
export async function downloaded(page: Page, name: string, content: string) {
  const download = page.waitForEvent('download');
  await action(page, name, 'Download');
  const result = await download;
  expect(result.suggestedFilename()).toBe(name);
  expect(await readFile((await result.path())!, 'utf8')).toBe(content);
}

