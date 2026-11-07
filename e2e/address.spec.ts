import { test, expect } from '@playwright/test';
import { signIn, createFolder, nav, revealRow, upload } from './support';
import { createSpace } from './spaces';

test('the address bar is a link to the space, folder, file and view on screen', async ({ page, context }, info) => {
  const prefix = info.project.name;
  const folder = 'Address checks';
  const name = 'address.txt';
  await signIn(page);
  await createSpace(page, `${prefix} Address`);

  const params = () => new URL(page.url()).searchParams;
  await expect.poll(() => params().get('site')).toBeTruthy();
  const site = params().get('site');

  await createFolder(page, folder);
  await page.getByRole('button', { name: `Actions for ${folder}`, exact: true }).locator('xpath=ancestor::tr').dblclick();
  await expect.poll(() => params().get('folder')).toBeTruthy();
  expect(params().get('site')).toBe(site);
  expect(page.url()).not.toContain('Address');
  const folderUrl = page.url();

  // Someone following the link lands in that folder, without the sender's session state.
  const reader = await context.newPage();
  await reader.goto(folderUrl);
  await expect(reader.getByText(folder).locator('visible=true').first()).toBeVisible();
  expect(new URL(reader.url()).searchParams.get('folder')).toBe(new URL(folderUrl).searchParams.get('folder'));
  await reader.close();

  await upload(page, name, 'link me');
  await revealRow(page, name);
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).locator('xpath=ancestor::tr').dblclick();
  await expect.poll(() => params().get('file')).toBeTruthy();
  const fileUrl = page.url();

  const fileReader = await context.newPage();
  await fileReader.goto(fileUrl);
  await expect(fileReader.getByRole('button', { name: 'Close preview' })).toBeVisible();
  await fileReader.close();

  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect.poll(() => page.url()).toBe(folderUrl);

  await nav(page, 'Trash');
  await expect.poll(() => params().get('view')).toBe('trash');
  const trashRead = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/trash'));
  await page.reload();
  expect((await trashRead).ok()).toBe(true);
  await expect.poll(() => params().get('view')).toBe('trash');
});
