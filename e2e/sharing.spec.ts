import { test, expect, type Page, type Request, type Response } from '@playwright/test';
import { signIn, createFolder, action, upload, nav, revealRow } from './support';
import { createSpace, switchSpace, invite, openMembers } from './spaces';
import { acceptInvitation } from './recipients';

/** Every folder access check the page makes for `folderId`, so a "hidden" assertion can wait for them to settle. */
function folderAccessChecks(page: Page, folderId: string) {
  const path = `/folders/${encodeURIComponent(folderId)}/metadata`;
  const matches = (method: string, url: string) => method === 'GET' && new URL(url).pathname.endsWith(path);
  let started = 0;
  const answers: (boolean | null)[] = [];
  const onRequest = (r: Request) => { if (matches(r.method(), r.url())) started++; };
  const onResponse = async (r: Response) => {
    if (!matches(r.request().method(), r.url())) return;
    try { answers.push(r.ok() ? (await r.json() as { canManage: boolean }).canManage : null); } catch { answers.push(null); }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return {
    settled: () => started > 0 && answers.length === started,
    answers: () => [...answers],
    stop: () => { page.off('request', onRequest); page.off('response', onResponse); },
  };
}

async function share(page: Page, folder: string, email: string, persona: string, level = 'edit') {
  await action(page, folder, 'Share');
  const dialog = page.getByRole('dialog', { name: `Share “${folder}”`, exact: true });
  await dialog.getByRole('combobox', { name: 'Person', exact: true }).fill(email);
  await dialog.getByRole('combobox', { name: 'Access', exact: true }).selectOption(level);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: `Access for ${persona}`, exact: true })).toHaveValue(level);
  return dialog;
}

test('viewer/editor invitations and folder access changes take effect in separate recipient browsers', async ({ page, browser }, info) => {
  const prefix = info.project.name;
  const space = `${prefix} Sharing roles`;
  const folder = 'Shared role checks';
  const name = 'roles.txt';
  const viewerContext = await browser.newContext({ viewport: page.viewportSize() });
  const editorContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    await signIn(page);
    await createSpace(page, space);
    await createFolder(page, folder);
    await action(page, folder, 'Open');
    await upload(page, name, 'Shared synthetic role contents');
    const viewerUrl = await invite(page, `${prefix}-viewer@canopy.test`, 'viewer');
    const editorUrl = await invite(page, `${prefix}-editor@canopy.test`, 'editor');
    const viewer = await viewerContext.newPage();
    const editor = await editorContext.newPage();
    await acceptInvitation(viewer, viewerUrl, `${prefix} viewer`, space);
    await acceptInvitation(editor, editorUrl, `${prefix} editor`, space);
    await action(viewer, folder, 'Open');
    await action(viewer, name, 'Open');
    const viewerPanel = viewer.getByRole('complementary', { name: 'Preview' });
    await expect(viewerPanel.getByText('Shared synthetic role contents', { exact: true })).toBeVisible();
    await expect(viewerPanel.getByRole('button', { name: 'Edit text', exact: true })).toBeHidden();
    await action(editor, folder, 'Open');
    await action(editor, name, 'Open');
    const editorPanel = editor.getByRole('complementary', { name: 'Preview' });
    await editorPanel.getByRole('button', { name: 'Edit text', exact: true }).click();
    await editorPanel.getByRole('textbox', { name: 'File text' }).fill('Editor saved these bytes');
    await editorPanel.getByRole('button', { name: 'Save text', exact: true }).click();
    await expect(editorPanel.getByRole('textbox', { name: 'File text' })).toBeHidden();
    await nav(page, 'My Drive');
    const access = await share(page, folder, `${prefix}-viewer@canopy.test`, `${prefix} viewer`, 'manage');
    const link = await access.getByRole('textbox', { name: 'Folder link', exact: true }).inputValue();
    expect(link).toContain('folder=');
    await viewer.goto(link);
    await expect(viewer.getByRole('button', { name: 'Share this folder', exact: true })).toBeVisible();
    await action(viewer, name, 'Open');
    await expect(viewerPanel.getByText('Editor saved these bytes', { exact: true })).toBeVisible();
    await expect(viewerPanel.getByRole('button', { name: 'Edit text', exact: true })).toBeVisible();
    const level = access.getByRole('combobox', { name: `Access for ${prefix} viewer`, exact: true });
    const downgrade = page.waitForResponse(r => r.request().method() === 'DELETE' &&
      new URL(r.url()).pathname.endsWith('/shares') && new URL(r.url()).searchParams.get('permission') === 'drive:manage');
    await level.selectOption('edit');
    expect((await downgrade).ok()).toBe(true);
    await expect(level).toHaveValue('edit');
    await expect(level).toBeEnabled();
    const checks = folderAccessChecks(viewer, new URL(link).searchParams.get('folder')!);
    await viewer.goto(link);
    await revealRow(viewer, name);
    await expect.poll(() => checks.settled()).toBe(true);
    checks.stop();
    expect(checks.answers()).not.toContain(true);
    expect(checks.answers()).toContain(false);
    await expect(viewer.getByRole('button', { name: 'Share this folder', exact: true })).toBeHidden();
    await action(viewer, name, 'Open');
    await expect(viewerPanel.getByRole('button', { name: 'Edit text', exact: true })).toBeVisible();
    await access.getByRole('button', { name: `Remove access for ${prefix} viewer`, exact: true }).click();
    await expect(access.getByRole('combobox', { name: `Access for ${prefix} viewer`, exact: true })).toBeHidden();
    await viewer.goto(link);
    await action(viewer, name, 'Open');
    await expect(viewerPanel.getByText('Editor saved these bytes', { exact: true })).toBeVisible();
    await expect(viewerPanel.getByRole('button', { name: 'Edit text', exact: true })).toBeHidden();
    const content = await viewerPanel.getByRole('link', { name: 'Download', exact: true }).getAttribute('href');
    await access.getByRole('button', { name: 'Close', exact: true }).click();
    const people = await openMembers(page);
    await people.getByRole('button', { name: `Remove ${prefix} viewer`, exact: true }).click();
    await people.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(people.getByRole('button', { name: `Remove ${prefix} viewer`, exact: true })).toBeHidden();
    const refused = await viewer.request.get(content!, { headers: { 'x-site': new URL(link).searchParams.get('site')! } });
    expect(refused.status()).toBe(401);
  } finally { await viewerContext.close(); await editorContext.close(); }
});

test('Shared with me opens a directly granted folder in another space and removes revoked grants', async ({ page, browser }, info) => {
  const prefix = info.project.name;
  const first = `${prefix} Shared origin`;
  const second = `${prefix} Recipient current`;
  const folder = 'Shared across spaces';
  const name = 'cross-space.txt';
  const recipientContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    await signIn(page);
    await createSpace(page, first);
    await createFolder(page, folder);
    await action(page, folder, 'Open');
    await upload(page, name, 'These bytes belong to the origin space');
    const recipient = await recipientContext.newPage();
    await acceptInvitation(recipient, await invite(page, `${prefix}-restricted@canopy.test`, 'viewer'), `${prefix} restricted`, first);
    await createSpace(page, second);
    await acceptInvitation(recipient, await invite(page, `${prefix}-restricted@canopy.test`, 'viewer'), `${prefix} restricted`, second);
    await switchSpace(page, first);
    const access = await share(page, folder, `${prefix}-restricted@canopy.test`, `${prefix} restricted`);
    await nav(recipient, 'Shared with me');
    await expect(recipient.getByRole('button', { name: `Actions for ${folder}`, exact: true })).toBeVisible();
    await action(recipient, folder, 'Open');
    await expect(recipient.getByRole('button', { name: `Spaces, current: ${first}`, exact: true })).toBeVisible();
    await action(recipient, name, 'Open');
    await expect(recipient.getByRole('complementary', { name: 'Preview' }).getByText('These bytes belong to the origin space', { exact: true })).toBeVisible();
    await access.getByRole('button', { name: `Remove access for ${prefix} restricted`, exact: true }).click();
    await expect(access.getByRole('combobox', { name: `Access for ${prefix} restricted`, exact: true })).toBeHidden();
    await recipient.getByRole('button', { name: 'Close preview', exact: true }).click();
    await switchSpace(recipient, second);
    await nav(recipient, 'Shared with me');
    await expect(recipient.getByText('No folders shared with you', { exact: true })).toBeVisible();
  } finally { await recipientContext.close(); }
});

test('a failed roster disables adding shares until the access dialog retries successfully', async ({ page }, info) => {
  const folder = `${info.project.name} Sharing retry`;
  await signIn(page);
  await createFolder(page, folder);
  await page.route('**/api/people', route => route.abort('failed'), { times: 1 });
  await action(page, folder, 'Share');
  const dialog = page.getByRole('dialog', { name: `Share “${folder}”`, exact: true });
  await expect(dialog.getByText(/Couldn’t read who is in this space/)).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Person', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Person', exact: true })).toBeEnabled();
});
