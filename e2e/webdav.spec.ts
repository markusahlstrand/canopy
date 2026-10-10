import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { signIn, createFolder, action, upload, downloaded, revealRow } from './support';
import { invite, openMembers } from './spaces';
import { acceptInvitation } from './recipients';

/** Mint an app password through the account menu, as a person would, and read it once. */
async function appPassword(page: Page, name: string) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Connect with WebDAV…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect with WebDAV', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Server address', exact: true })).toHaveValue(/\/dav\/$/);
  await dialog.getByRole('textbox', { name: 'New app password', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const secret = await dialog.getByRole('textbox', { name: `App password for ${name}`, exact: true }).inputValue();
  expect(secret).toMatch(/^canopy_/);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();
  return secret;
}

/** A WebDAV client: Basic auth only, no cookies relied on. */
function davClient(request: APIRequestContext, secret: string) {
  const authorization = `Basic ${Buffer.from(`webdav-client:${secret}`).toString('base64')}`;
  return (path: string, method: string, options: { data?: string; headers?: Record<string, string> } = {}) =>
    request.fetch(path, { method, data: options.data, headers: { authorization, ...options.headers } });
}
const enc = (segments: string[], collection = false) => `/dav/${segments.map(encodeURIComponent).join('/')}${collection ? '/' : ''}`;
/** The same path as a listing's decoded href. */
const dec = (segments: string[], collection = false) => `/dav/${segments.join('/')}${collection ? '/' : ''}`;
const hrefs = async (response: { text(): Promise<string> }) =>
  [...(await response.text()).matchAll(/<D:href>([^<]+)<\/D:href>/g)].map(match => decodeURIComponent(match[1]!));

test('WebDAV mounts spaces and direct grants with app passwords, and revocation closes known URLs', async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  const prefix = info.project.name;
  // The default space: the owner may create only 10 spaces an hour, and the other
  // specs already use them.
  const space = 'Acceptance Drive';
  const papers = `${prefix} WebDAV papers`;
  const recipientName = `${prefix} webdav`;
  const recipientContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    await signIn(page);
    await createFolder(page, papers);
    const owner = davClient(page.request, await appPassword(page, `${prefix} Finder`));

    // An unknown password is refused before anything is resolved.
    expect((await davClient(page.request, 'canopy_wrong')('/dav/', 'PROPFIND')).status()).toBe(401);
    const root = await owner('/dav/', 'PROPFIND', { headers: { Depth: '1' } });
    expect(root.status()).toBe(207);
    expect(await hrefs(root)).toContain(dec([space], true));

    // Bytes written over WebDAV are the drive's bytes, and the other way round.
    expect((await owner(enc([space, papers, 'from-dav.txt']), 'PUT', { data: 'Written by a WebDAV client' })).status()).toBe(201);
    expect((await owner(enc([space, papers, 'from-dav.txt']), 'PUT', { data: 'Second WebDAV version' })).status()).toBe(204);
    await action(page, papers, 'Open');
    await revealRow(page, 'from-dav.txt');
    await downloaded(page, 'from-dav.txt', 'Second WebDAV version');
    await upload(page, 'from-ui.txt', 'Uploaded in the browser');
    expect(await (await owner(enc([space, papers, 'from-ui.txt']), 'GET')).text()).toBe('Uploaded in the browser');
    const listing = await owner(enc([space, papers], true), 'PROPFIND', { headers: { Depth: '1' } });
    expect(await hrefs(listing)).toEqual(expect.arrayContaining([dec([space, papers, 'from-dav.txt']), dec([space, papers, 'from-ui.txt'])]));

    expect((await owner(enc([space, papers, 'Drafts'], true), 'MKCOL')).status()).toBe(201);
    expect((await owner(enc([space, papers, 'from-ui.txt']), 'MOVE', { headers: { Destination: enc([space, papers, 'Drafts', 'renamed.txt']) } })).status()).toBe(201);
    expect(await (await owner(enc([space, papers, 'Drafts', 'renamed.txt']), 'GET')).text()).toBe('Uploaded in the browser');
    expect((await owner(enc([space, papers, 'Drafts'], true), 'DELETE')).status()).toBe(403);

    // A viewer reads but cannot write; a direct grant makes the folder writable and mounts it.
    const recipientPage = await recipientContext.newPage();
    await acceptInvitation(recipientPage, await invite(page, `${prefix}-webdav@canopy.test`, 'viewer'), recipientName, space);
    const recipient = davClient(recipientPage.request, await appPassword(recipientPage, `${prefix} Explorer`));
    expect(await (await recipient(enc([space, papers, 'from-dav.txt']), 'GET')).text()).toBe('Second WebDAV version');
    expect((await recipient(enc([space, papers, 'viewer.txt']), 'PUT', { data: 'refused' })).status()).toBe(403);
    expect(await hrefs(await recipient('/dav/', 'PROPFIND', { headers: { Depth: '1' } }))).not.toContain('/dav/Shared with me/');

    // Back to the space root, where the folder is shared from.
    await page.goto('/');
    await expect(page.getByRole('button', { name: `Spaces, current: ${space}`, exact: true })).toBeVisible();
    await revealRow(page, papers);
    await action(page, papers, 'Share');
    const access = page.getByRole('dialog', { name: `Share “${papers}”`, exact: true });
    await access.getByRole('combobox', { name: 'Person', exact: true }).fill(`${prefix}-webdav@canopy.test`);
    await access.getByRole('combobox', { name: 'Access', exact: true }).selectOption('edit');
    await access.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(access.getByRole('combobox', { name: `Access for ${recipientName}`, exact: true })).toHaveValue('edit');

    const shared = await recipient('/dav/Shared%20with%20me/', 'PROPFIND', { headers: { Depth: '1' } });
    expect(shared.status()).toBe(207);
    const mount = (await hrefs(shared)).find(href => href.startsWith(`/dav/Shared with me/${papers} — ${space} [`));
    expect(mount).toBeTruthy();
    const inMount = (name: string) => `${mount!.split('/').map(encodeURIComponent).join('/')}${encodeURIComponent(name)}`;
    expect((await recipient(inMount('from-recipient.txt'), 'PUT', { data: 'Written through the grant' })).status()).toBe(201);
    expect(await (await owner(enc([space, papers, 'from-recipient.txt']), 'GET')).text()).toBe('Written through the grant');
    expect((await recipient(enc([space, 'outside.txt']), 'PUT', { data: 'refused' })).status()).toBe(403);

    // Withdrawing the grant closes the mount, including the URL the client already knows.
    await access.getByRole('button', { name: `Remove access for ${recipientName}`, exact: true }).click();
    await expect(access.getByRole('combobox', { name: `Access for ${recipientName}`, exact: true })).toBeHidden();
    await access.getByRole('button', { name: 'Close', exact: true }).click();
    expect((await recipient(inMount('from-recipient.txt'), 'GET')).status()).toBe(404);
    expect((await recipient(inMount('after.txt'), 'PUT', { data: 'refused' })).status()).toBe(404);

    // Removing the member removes the space from their mount, and its known URLs stop working.
    const people = await openMembers(page);
    await people.getByRole('button', { name: `Remove ${recipientName}`, exact: true }).click();
    await people.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(people.getByRole('button', { name: `Remove ${recipientName}`, exact: true })).toBeHidden();
    await people.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await hrefs(await recipient('/dav/', 'PROPFIND', { headers: { Depth: '1' } }))).not.toContain(dec([space], true));
    expect((await recipient(enc([space, papers, 'from-dav.txt']), 'GET')).status()).toBe(404);

    // Revoking the owner's password ends that client's access at once.
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connect with WebDAV…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect with WebDAV', exact: true });
    await dialog.getByRole('button', { name: `Revoke ${prefix} Finder`, exact: true }).click();
    await expect(dialog.getByRole('button', { name: `Revoke ${prefix} Finder`, exact: true })).toBeHidden();
    expect((await owner('/dav/', 'PROPFIND')).status()).toBe(401);
  } finally {
    await recipientContext.close();
  }
});
