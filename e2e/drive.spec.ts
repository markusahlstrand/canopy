import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { revealRow, signIn, nav, createFolder, action, rename, upload, downloaded } from './support';

test('root, nested folders, file lifecycle and every file version retain their identity', async ({ page }, testInfo) => {
  const prefix = testInfo.project.name;
  const folder = `${prefix} Documents`;
  const renamedFolder = `${prefix} Documents renamed`;
  const target = `${prefix} Archive`;
  const filename = `${prefix}-notes.txt`;
  const renamedFile = `${prefix}-renamed.txt`;
  const first = 'S12a original synthetic contents\n';
  const second = 'S12a replacement synthetic contents\n';
  await signIn(page);
  if (prefix === 'desktop') await expect(page.getByText('Acceptance Drive is empty', { exact: true })).toBeVisible();
  await createFolder(page, folder);
  await createFolder(page, target);
  await rename(page, folder, renamedFolder, true);
  await action(page, renamedFolder, 'Open');
  await expect(page.getByText('This folder is empty', { exact: true })).toBeVisible();
  await expect(page.locator('header').getByText(renamedFolder, { exact: true }).filter({ visible: true })).toBeVisible();
  await upload(page, filename, first);
  await downloaded(page, filename, first);
  await rename(page, filename, renamedFile);
  await upload(page, renamedFile, second);
  await action(page, renamedFile, 'Open');
  const preview = page.getByRole('complementary', { name: 'Preview' });
  await expect(preview.getByText(second.trim(), { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Versions', exact: true }).click();
  await expect(preview.getByRole('link', { name: /Download version/ })).toHaveCount(2);
  const links = preview.getByRole('link', { name: /Download version/ });
  for (const [index, expected] of [second, first].entries()) {
    const download = page.waitForEvent('download');
    await links.nth(index).click();
    expect(await readFile((await (await download).path())!, 'utf8')).toBe(expected);
  }
  await preview.getByRole('button', { name: 'Close preview' }).click();
  await action(page, renamedFile, 'Move');
  const move = page.getByRole('dialog', { name: `Move ${renamedFile}`, exact: true });
  await move.getByRole('button', { name: 'My Drive', exact: true }).click();
  await move.getByRole('button', { name: target, exact: true }).click();
  await move.getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(move).toBeHidden();
  await expect(page.getByText('This folder is empty', { exact: true })).toBeVisible();
  await nav(page, 'My Drive');
  await action(page, target, 'Open');
  await downloaded(page, renamedFile, second);
  await action(page, renamedFile, 'Delete');
  await expect(page.getByRole('button', { name: `Actions for ${renamedFile}` })).toBeHidden();
  await nav(page, 'Trash');
  await action(page, renamedFile, 'Restore');
  await nav(page, 'My Drive');
  await action(page, target, 'Open');
  await downloaded(page, renamedFile, second);
  await nav(page, 'My Drive');
  await action(page, renamedFolder, 'Move');
  const moveFolder = page.getByRole('dialog', { name: `Move ${renamedFolder}`, exact: true });
  await moveFolder.getByRole('button', { name: target, exact: true }).click();
  await moveFolder.getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(moveFolder).toBeHidden();
  await action(page, target, 'Open');
  await action(page, renamedFolder, 'Open');
  await expect(page.getByText('This folder is empty', { exact: true })).toBeVisible();
  if (prefix === 'mobile') {
    await page.getByRole('button', { name: 'Back to parent folder' }).click();
    await expect(page.getByRole('button', { name: `Actions for ${renamedFile}` })).toBeVisible();
  } else {
    await page.locator('header').getByRole('button', { name: target, exact: true }).click();
    await expect(page.getByRole('button', { name: `Actions for ${renamedFile}` })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('real name collisions and a failed request keep the proposed folder name for retry', async ({ page }, testInfo) => {
  const name = `${testInfo.project.name} Retry`;
  await signIn(page);
  await createFolder(page, name);
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'New folder' });
  await dialog.getByRole('textbox').fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue(name);
  await dialog.getByRole('textbox').fill(`${name} corrected`);
  // Inject one transport failure only; all accepted writes still go to the worker.
  await page.route('**/api/folders/*/folders', async route => {
    if (route.request().method() === 'POST') {
      await route.abort('failed');
      await page.unroute('**/api/folders/*/folders');
    } else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveValue(`${name} corrected`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toBeHidden();
  await revealRow(page, `${name} corrected`);
});

test('new folders and their contents remain reachable beyond the first listing page', async ({ page }, info) => {
  test.setTimeout(120_000);
  await signIn(page);
  const parent = `${info.project.name} Paged browsing`;
  await createFolder(page, parent);
  await action(page, parent, 'Open');
  for (let index = 0; index < 21; index++) await createFolder(page, `Page folder ${String(index).padStart(2, '0')}`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Actions for Page folder 20', exact: true })).toBeVisible();
  await action(page, 'Page folder 20', 'Open');
  await upload(page, 'last-page.txt', 'Bytes reached through the second folder page');
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Back to parent folder', exact: true }).click();
  else await page.getByRole('button', { name: parent, exact: true }).click();
  await action(page, 'Page folder 20', 'Open');
  await downloaded(page, 'last-page.txt', 'Bytes reached through the second folder page');
});
