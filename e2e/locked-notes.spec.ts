import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { signIn, createFolder, action } from './support';

const space = 'Acceptance Drive';
const password = 'correct horse battery';

async function openPlugins(page: Page) {
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: `Manage ${space}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Space plugins', exact: true }).click();
  return page.getByRole('dialog', { name: 'Plugins', exact: true });
}
async function closePlugins(page: Page) {
  await page.getByRole('dialog', { name: 'Plugins', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
}
/** Open the rail's New menu and return its entries; on a phone the rail lives in the navigation sheet. */
async function openNew(page: Page) {
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  return page.getByRole('menu');
}
async function closeNew(page: Page) {
  await page.keyboard.press('Escape');
  if (page.viewportSize()!.width < 768) await page.getByRole('dialog', { name: 'Drive navigation', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
}
/** Installs are space-wide and both viewports share one server, so each test starts from none. */
async function removeLockedNotes(page: Page) {
  const { plugins } = await (await page.request.get('/api/plugins')).json() as { plugins: { id: string; plugin_id: string }[] };
  for (const row of plugins.filter(row => row.plugin_id === 'locked-notes')) expect((await page.request.delete(`/api/plugins/${row.id}`)).ok()).toBe(true);
}
async function newLockedNote(page: Page, name: string) {
  await (await openNew(page)).getByRole('menuitem', { name: 'Locked note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New locked note' });
  await expect(dialog.getByRole('textbox')).toHaveValue('Untitled');
  await dialog.getByRole('textbox').fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  return dialog;
}

test('Locked Notes installed for everyone: card offers only Uninstall, New creates, encrypts and reopens a note', async ({ page }, info) => {
  await signIn(page);
  page.on('dialog', dialog => dialog.accept());
  await removeLockedNotes(page);
  await page.reload();
  const folder = `${info.project.name} Locked notes`;
  await createFolder(page, folder);
  await action(page, folder, 'Open');

  // Not installed: New has no Locked note entry.
  await expect((await openNew(page)).getByRole('menuitem', { name: 'New folder' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Locked note', exact: true })).toHaveCount(0);
  await closeNew(page);

  const plugins = await openPlugins(page);
  const card = plugins.getByRole('region', { name: 'Locked Notes', exact: true });
  await card.getByRole('button', { name: `Install for everyone in ${space}`, exact: true }).click();
  const confirm = card.getByRole('group', { name: 'Confirm Locked Notes' });
  await expect(confirm.getByText('Save changes to that file')).toBeVisible();
  await confirm.getByRole('button', { name: 'Confirm install', exact: true }).click();
  // A space install already reaches this person: no personal Install, no second space Install.
  await expect(card.getByRole('button', { name: `Uninstall for everyone in ${space}`, exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: `Install for everyone in ${space}`, exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^Update/ })).toHaveCount(0);
  await closePlugins(page);

  await expect(await newLockedNote(page, 'Diary')).toBeHidden();
  const panel = page.getByRole('complementary', { name: 'Preview' });
  const frame = page.frameLocator('iframe[title="Locked Notes"]');
  await expect(frame.getByText("This file isn't encrypted yet. Choose a password to encrypt it.")).toBeVisible();
  await frame.getByPlaceholder('New password').fill(password);
  await frame.getByPlaceholder('Repeat password').fill(password);
  await frame.getByRole('button', { name: 'Encrypt', exact: true }).click();
  await frame.locator('textarea').fill('Only for me');
  await frame.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(frame.getByText('Saved, encrypted ✓')).toBeVisible();
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();

  // What the drive stores is the envelope, never the text.
  const download = page.waitForEvent('download');
  await action(page, 'Diary.locked', 'Download');
  const stored = await readFile((await (await download).path())!, 'utf8');
  expect(stored).toContain('canopy-locked');
  expect(stored).not.toContain('Only for me');

  await action(page, 'Diary.locked', 'Open');
  await frame.getByPlaceholder('Password').fill(password);
  await frame.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(frame.locator('textarea')).toHaveValue('Only for me');
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();

  // New never writes over a note that already has content under that name.
  const again = await newLockedNote(page, 'Diary');
  await expect(again.getByRole('alert')).toHaveText("This folder already has a file named 'Diary.locked'.");
  await again.getByRole('button', { name: 'Cancel', exact: true }).click();
  await action(page, 'Diary.locked', 'Open');
  await frame.getByPlaceholder('Password').fill(password);
  await frame.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(frame.locator('textarea')).toHaveValue('Only for me');
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();

  // Uninstalling from the card takes the New entry with it.
  await openPlugins(page);
  await card.getByRole('button', { name: `Uninstall for everyone in ${space}`, exact: true }).click();
  await expect(card.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: `Install for everyone in ${space}`, exact: true })).toBeVisible();
  await closePlugins(page);
  await expect((await openNew(page)).getByRole('menuitem', { name: 'New folder' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Locked note', exact: true })).toHaveCount(0);
  await closeNew(page);
});

test('an install saved before Locked Notes declared its New entry is offered Update, which adds the entry', async ({ page }) => {
  await signIn(page);
  page.on('dialog', dialog => dialog.accept());
  await removeLockedNotes(page);
  // The manifest as it shipped before `creators`, saved the way a catalog install is (no provenance).
  const current = JSON.parse(await readFile('examples/plugins/locked-notes/canopy.json', 'utf8'));
  const { creators: _creators, store: _store, ...contributes } = current.contributes;
  const old = { ...current, contributes };
  delete old.$schema;
  const saved = await page.request.put('/api/plugins', { data: {
    manifest: old, source: await readFile('examples/plugins/locked-notes/index.js', 'utf8'),
    expectedRevision: null, forSpace: true, acceptCapabilities: old.capabilities,
  } });
  expect(saved.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: `Spaces, current: ${space}` })).toBeVisible();

  await expect((await openNew(page)).getByRole('menuitem', { name: 'New folder' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Locked note', exact: true })).toHaveCount(0);
  await closeNew(page);

  const plugins = await openPlugins(page);
  const card = plugins.getByRole('region', { name: 'Locked Notes', exact: true });
  await card.getByRole('button', { name: `Update for everyone in ${space}`, exact: true }).click();
  await expect(card.getByRole('button', { name: /^Update/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: `Uninstall for everyone in ${space}`, exact: true })).toBeVisible();
  await closePlugins(page);

  await expect((await openNew(page)).getByRole('menuitem', { name: 'Locked note', exact: true })).toBeVisible();
  await closeNew(page);
  await removeLockedNotes(page);
});
