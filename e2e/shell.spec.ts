import { test, expect } from '@playwright/test';
import { signIn, createFolder } from './support';
import { createSpace, openSpaces, switchSpace, openMembers, invite } from './spaces';

test('create, switch, style and manage a long-named space without sending actions to the previous space', async ({ page }, info) => {
  const name = `${info.project.name} A very long acceptance space name for testing the narrow navigation`;
  const renamed = `${info.project.name} Styled acceptance space`;
  await signIn(page);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await expect(page.getByRole('menu').getByText('Local Owner', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await createSpace(page, name);
  await expect(page.getByText(`${name} is empty`, { exact: true })).toBeVisible();
  await createFolder(page, 'Only in the new space');
  await switchSpace(page, 'Acceptance Drive');
  await expect(page.getByRole('button', { name: 'Actions for Only in the new space' })).toBeHidden();
  await switchSpace(page, name);
  await expect(page.getByRole('button', { name: 'Actions for Only in the new space' })).toBeVisible();
  const spaces = await openSpaces(page);
  await spaces.getByRole('button', { name: 'Space settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Space settings', exact: true });
  await settings.getByRole('textbox', { name: 'Space name', exact: true }).fill(renamed);
  await settings.getByRole('button', { name: 'Choose space icon and color' }).click();
  await page.getByRole('button', { name: 'Icon star', exact: true }).click();
  await page.getByRole('button', { name: 'Color #ef4444', exact: true }).click();
  await page.keyboard.press('Escape');
  await settings.getByRole('button', { name: 'Save space', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('button', { name: `Spaces, current: ${renamed}` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: `Spaces, current: ${renamed}` })).toBeVisible();
  const selected = await page.evaluate(() => localStorage.getItem('canopy.site'));
  const saved = await (await page.request.get('/api/space-settings', { headers: { 'x-site': selected! } })).json();
  expect(saved).toMatchObject({ name: renamed, icon: 'star', color: '#ef4444' });
  const email = `${info.project.name}-viewer@canopy.test`;
  await invite(page, email, 'viewer');
  const people = await openMembers(page);
  await people.getByRole('button', { name: `Withdraw the invitation for ${email}`, exact: true }).click();
  await expect(people.getByRole('button', { name: `Withdraw the invitation for ${email}`, exact: true })).toBeHidden();
  await people.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('space-list loading, failure and no-match states have an accessible recovery', async ({ page }) => {
  await signIn(page);
  await page.route('**/api/sites', route => route.abort('failed'), { times: 1 });
  const spaces = await openSpaces(page);
  await spaces.getByRole('button', { name: 'Refresh spaces', exact: true }).click();
  await expect(spaces.getByRole('alert')).toContainText('Could not refresh spaces');
  await spaces.getByRole('button', { name: 'Retry spaces', exact: true }).click();
  await expect(spaces.getByRole('alert')).toBeHidden();
  await spaces.getByRole('textbox', { name: 'Find a space', exact: true }).fill('NoSuchSyntheticSpace');
  await expect(spaces.getByText(/No other spaces match/)).toBeVisible();
  await expect(spaces.getByText('Current space', { exact: true })).toBeVisible();
});

test('offline shell keeps saved context, disables writes and recovers on reconnect', async ({ page, context }) => {
  await signIn(page);
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('canopy.scope-mirror');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const request = database.transaction('progress').objectStore('progress').getAll();
      request.onsuccess = () => { database.close(); resolve(request.result.some(row => row.ready)); };
      request.onerror = () => { database.close(); reject(request.error); };
    };
  }))).toBe(true);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(/Offline — showing saved names/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload files', exact: true })).toBeDisabled();
  const spaces = await openSpaces(page);
  await expect(spaces.getByRole('button', { name: 'Create space', exact: true })).toBeDisabled();
  await expect(spaces.getByRole('button', { name: 'Refresh spaces', exact: true })).toBeDisabled();
  await spaces.getByRole('button', { name: 'Close', exact: true }).click();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(/Offline — showing saved names/)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Upload files', exact: true }).first()).toBeEnabled();
});
