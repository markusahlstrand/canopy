import { test, expect, type Page, type APIResponse } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { signIn, createFolder, action, upload, rename } from './support';
import { invite, openMembers } from './spaces';
import { acceptInvitation } from './recipients';

type Saved = { name: string; fileId: string; versionId: string; principal: string; space: string; savedAt: number; pinnedBy: string[]; text: string };
type Pin = { folderId: string; name: string; status: string; principal: string; space: string };
async function contentState(page: Page) {
  return page.evaluate(() => new Promise<{ versions: Saved[]; pins: Pin[] }>((resolve, reject) => {
    const open = indexedDB.open('canopy.scope-content');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['versions', 'pins']);
      const versions = tx.objectStore('versions').getAll();
      const pins = tx.objectStore('pins').getAll();
      tx.oncomplete = () => { db.close(); resolve({ versions: versions.result.map(row => ({ ...row, bytes: undefined, text: new TextDecoder().decode(row.bytes) })), pins: pins.result }); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function mirrorReady(page: Page) {
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('canopy.scope-mirror');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('progress').objectStore('progress').getAll();
      request.onsuccess = () => { db.close(); resolve(request.result.some(row => row.ready)); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }))).toBe(true);
}
async function pin(page: Page) {
  await page.getByRole('button', { name: 'Available offline on this device', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove offline copy', exact: true })).toBeVisible({ timeout: 30_000 });
}

test('native recursive and paged pins recover partial downloads; offline bytes are read-only and overlapping pins unpin correctly', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  const folder = `${info.project.name} Recursive offline`;
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await createFolder(page, 'Nested');
  await action(page, 'Nested', 'Open');
  await upload(page, 'nested.txt', 'Nested synthetic saved bytes');
  await page.getByRole('button', { name: page.viewportSize()!.width < 768 ? 'Back to parent folder' : folder, exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(Array.from({ length: 52 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Offline fixture ${i}`) })));
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploaded', { exact: true })).toHaveCount(53, { timeout: 30_000 });
  let listingUrl: string | undefined = '/api/folders/root/folders';
  let folderId: string | undefined;
  while (listingUrl && !folderId) {
    const response: APIResponse = await page.request.get(listingUrl);
    const entries: { name: string; id: string }[] = await response.json();
    folderId = entries.find((row: {name:string}) => row.name === folder)?.id;
    listingUrl = response.headers().link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  expect(folderId).toBeTruthy();
  const files = await (await page.request.get(`/api/folders/${folderId}/files`)).json();
  const failingId = files.find((row: {name:string}) => row.name === 'f010.txt').id;
  await page.route(`**/api/files/${failingId}/versions/*/content*`, route => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Available offline on this device', exact: true }).click();
  await expect(page.getByText('Some files are saved offline. Retry to complete this folder.', { exact: true })).toBeVisible();
  const partial = await contentState(page);
  expect(partial.pins[0]?.status).toBe('partial');
  expect(partial.versions.length).toBeGreaterThan(0);
  expect(partial.versions.length).toBeLessThan(53);
  await page.getByRole('button', { name: 'Retry offline download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove offline copy', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await contentState(page)).versions.length).toBe(53);
  const complete = await contentState(page);
  expect(complete.pins).toHaveLength(1);
  expect(complete.pins[0].status).toBe('ready');
  expect(complete.versions.every(row => row.principal === complete.pins[0].principal && row.space === complete.pins[0].space && row.savedAt > 0)).toBe(true);
  await mirrorReady(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(/Offline — showing saved names/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload files', exact: true })).toBeDisabled();
  await action(page, 'f000.txt', 'Open');
  const preview = page.getByRole('region', { name: 'Offline preview of f000.txt', exact: true });
  await expect(preview.getByText('Offline fixture 0', { exact: true })).toBeVisible();
  await expect(preview.getByText(/Read-only saved version .+ from/)).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Edit text', exact: true })).toBeHidden();
  const download = page.waitForEvent('download');
  await preview.getByRole('link', { name: 'Download saved version', exact: true }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe('f000.txt');
  expect(await readFile((await result.path())!, 'utf8')).toBe('Offline fixture 0');
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for f000.txt', exact: true }).click();
  for (const name of ['Rename', 'Move', 'Delete']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await action(page, 'Nested', 'Open');
  await pin(page);
  await expect.poll(async () => (await contentState(page)).pins.length).toBe(2);
  await page.getByRole('button', { name: page.viewportSize()!.width < 768 ? 'Back to parent folder' : folder, exact: true }).click();
  await page.getByRole('button', { name: 'Remove offline copy', exact: true }).click();
  await expect.poll(async () => (await contentState(page)).versions.map(row => row.name)).toEqual(['nested.txt']);
  await action(page, 'Nested', 'Open');
  await page.getByRole('button', { name: 'Remove offline copy', exact: true }).click();
  await expect.poll(async () => (await contentState(page)).versions.length).toBe(0);
  expect((await contentState(page)).pins).toEqual([]);
});

test('saved folders reconcile renamed files, new bytes, additions and trash without a manual repin', async ({ page }, info) => {
  test.setTimeout(120_000);
  const folder = `${info.project.name} Reconcile offline`;
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await upload(page, 'before.txt', 'Old saved bytes');
  await pin(page);
  const old = (await contentState(page)).versions[0];
  await rename(page, 'before.txt', 'after.txt');
  await action(page, 'after.txt', 'Open');
  const preview = page.getByRole('complementary', { name: 'Preview' });
  await preview.getByRole('button', { name: 'Edit text', exact: true }).click();
  await preview.getByRole('textbox', { name: 'File text' }).fill('Reconciled saved bytes');
  await preview.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(preview.getByRole('textbox', { name: 'File text' })).toBeHidden();
  await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  await upload(page, 'added.txt', 'New saved file');
  await expect.poll(async () => (await contentState(page)).versions.map(row => [row.name, row.text]).sort(), { timeout: 45_000 }).toEqual([['added.txt', 'New saved file'], ['after.txt', 'Reconciled saved bytes']]);
  expect((await contentState(page)).versions.some(row => row.versionId === old.versionId)).toBe(false);
  await action(page, 'added.txt', 'Delete');
  await expect.poll(async () => (await contentState(page)).versions.map(row => row.name), { timeout: 45_000 }).toEqual(['after.txt']);
});

test('native quota failures retain earlier bytes, stay incomplete and recover without unhandled rejections', async ({ page, context }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  const folder = `${info.project.name} Native quota`;
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await upload(page, 'a-small.txt', 'Small retained fixture');
  await pin(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/files/*/versions/*/content*', async route => { await held; await route.continue(); }, { times: 1 });
  await page.locator('input[type=file]').setInputFiles({ name: 'z-large.txt', mimeType: 'application/octet-stream', buffer: randomBytes(200_000) });
  await expect(page.getByRole('button', { name: 'Actions for z-large.txt', exact: true })).toBeVisible();
  await mirrorReady(page);
  const cdp = await context.newCDPSession(page);
  const origin = new URL(page.url()).origin;
  const usage = await cdp.send('Storage.getUsageAndQuota', { origin });
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: usage.usage + 100_000 });
  expect((await cdp.send('Storage.getUsageAndQuota', { origin })).overrideActive).toBe(true);
  try {
    // Chromium caches available quota for 30 seconds. Hold the real download
    // until that native allowance expires instead of filling device storage.
    await new Promise(resolve => setTimeout(resolve, 31_000));
    release();
    await expect(page.getByRole('alert').filter({ hasText: /storage|quota/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry offline download', exact: true })).toBeEnabled();
    const state = await contentState(page);
    expect(state.versions.map(row => row.text)).toEqual(['Small retained fixture']);
    expect(['partial', 'syncing']).toContain(state.pins[0].status);
    expect(errors).toEqual([]);
  } finally { release(); await cdp.send('Storage.overrideQuotaForOrigin', { origin }); }
  await page.getByRole('button', { name: 'Retry offline download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove offline copy', exact: true })).toBeVisible();
  expect((await contentState(page)).versions.map(row => row.name).sort()).toEqual(['a-small.txt', 'z-large.txt']);
  expect(errors).toEqual([]);
});

test('sign-out in another tab clears native pins, bytes and the open saved preview', async ({ page, context }, info) => {
  await signIn(page);
  const folder = `${info.project.name} Logout offline`;
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await upload(page, 'logout.txt', 'Clear these private synthetic bytes');
  await pin(page);
  await mirrorReady(page);
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('button', { name: 'Account menu', exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await action(page, 'logout.txt', 'Open');
  await expect(page.getByRole('region', { name: 'Offline preview of logout.txt', exact: true }).getByText('Clear these private synthetic bytes', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'Account menu', exact: true }).click();
  await second.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect.poll(async () => (await contentState(page)).versions.length).toBe(0);
  expect((await contentState(page)).pins).toEqual([]);
  await expect(page.getByText('Clear these private synthetic bytes', { exact: true })).toBeHidden();
  await context.setOffline(false);
});

test('a real member revocation clears a recipient’s saved bytes after an online access check', async ({ page, browser }, info) => {
  const prefix = info.project.name;
  const folder = `${prefix} Revoked offline`;
  const recipientContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    await signIn(page);
    await createFolder(page, folder);
    await action(page, folder, 'Open');
    await upload(page, 'revoked.txt', 'Recipient synthetic saved bytes');
    const recipient = await recipientContext.newPage();
    await acceptInvitation(recipient, await invite(page, `${prefix}-viewer@canopy.test`, 'viewer'), `${prefix} viewer`, 'Acceptance Drive');
    await action(recipient, folder, 'Open');
    await pin(recipient);
    expect((await contentState(recipient)).versions[0].text).toBe('Recipient synthetic saved bytes');
    const people = await openMembers(page);
    await people.getByRole('button', { name: `Remove ${prefix} viewer`, exact: true }).click();
    await people.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(people.getByRole('button', { name: `Remove ${prefix} viewer`, exact: true })).toBeHidden();
    await recipient.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(async () => (await contentState(recipient)).versions.length).toBe(0);
    expect((await contentState(recipient)).pins).toEqual([]);
  } finally { await recipientContext.close(); }
});

test('a decoded oversized stream stays incomplete and an uncached offline preview explains the missing bytes', async ({ page, context }, info) => {
  const { gzipSync } = await import('node:zlib');
  await signIn(page);
  const folder = `${info.project.name} Oversized offline`;
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await upload(page, 'oversized.txt', 'Small real fixture before the injected oversized response');
  // The compressed Content-Length is below the budget. Native Fetch decodes a
  // larger body, exercising the streaming limit rather than the header check.
  const oversized = gzipSync(Buffer.alloc(20_000_001, 120));
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip',
      'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true' });
    response.end(oversized);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address() as { port: number };
  await page.route('**/api/files/*/versions/*/content*', route => route.continue({ url: `http://127.0.0.1:${address.port}/oversized` }), { times: 1 });
  try {
  await page.getByRole('button', { name: 'Available offline on this device', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /20 MB offline file limit/ })).toBeVisible();
  expect((await contentState(page)).pins[0].status).toBe('error');
  expect((await contentState(page)).versions).toEqual([]);
  await mirrorReady(page);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await action(page, 'oversized.txt', 'Open');
  const preview = page.getByRole('region', { name: 'Offline preview of oversized.txt', exact: true });
  await expect(preview.getByText(/no saved offline copy/)).toBeVisible();
  await expect(preview.getByRole('link', { name: 'Download saved version', exact: true })).toBeHidden();
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Retry offline download', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove offline copy', exact: true })).toBeVisible();
  expect((await contentState(page)).versions[0].text).toBe('Small real fixture before the injected oversized response');
  } finally { await new Promise<void>(resolve => fixture.close(() => resolve())); }
});

test('changing the authenticated principal invalidates an in-flight native download and clears previous pins', async ({ page, context, browser }, info) => {
  const prefix = info.project.name;
  const recipientContext = await browser.newContext({ viewport: page.viewportSize() });
  let release!: () => void;
  try {
    await signIn(page);
    const folder = `${prefix} Principal offline`;
    await createFolder(page, folder);
    await action(page, folder, 'Open');
    await upload(page, 'a-saved.txt', 'Previous principal bytes');
    await upload(page, 'z-pending.txt', 'Late download must not recreate previous principal bytes');
    const recipient = await recipientContext.newPage();
    await acceptInvitation(recipient, await invite(page, `${prefix}-editor@canopy.test`, 'editor'), `${prefix} editor`, 'Acceptance Drive');
    const principal = (await (await recipient.request.get('/api/me')).json()).principal;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    await page.route('**/api/files/*/versions/*/content*', async route => {
      if (++requests === 2) { entered(); await blocked; }
      await route.continue().catch(() => {});
    });
    await page.getByRole('button', { name: 'Available offline on this device', exact: true }).click();
    await started;
    expect((await contentState(page)).versions[0].text).toBe('Previous principal bytes');
    await context.clearCookies();
    await context.addCookies(await recipientContext.cookies());
    await page.reload();
    await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toBeVisible();
    expect((await (await page.request.get('/api/me')).json()).principal).toBe(principal);
    await expect.poll(async () => (await contentState(page)).versions.length).toBe(0);
    release();
    expect((await contentState(page)).pins).toEqual([]);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    expect((await contentState(page)).versions).toEqual([]);
  } finally { release?.(); await recipientContext.close(); }
});
