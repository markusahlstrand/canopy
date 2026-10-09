import { test, expect } from '@playwright/test';
import { signIn, createFolder, action, upload } from './support';
import { createSpace, switchSpace, openSpaces, invite } from './spaces';
import { acceptInvitation } from './recipients';

test('name, extracted contents and metadata match in results and the keyboard palette; refresh failures clear stale selection', async ({ page }, info) => {
  const prefix = info.project.name;
  const marker = `cobalt${prefix}`;
  const folder = `${prefix} Search acceptance`;
  const nameFile = `${marker}-name.txt`;
  const bodyFile = `${prefix}-body.txt`;
  const metadataFile = `${prefix}-metadata.txt`;
  const body = `Synthetic document contents with ${marker} in the middle.`;
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await page.locator('input[type=file]').setInputFiles([
    { name: nameFile, mimeType: 'text/plain', buffer: Buffer.from('Name-only match') },
    { name: bodyFile, mimeType: 'text/plain', buffer: Buffer.from(body) },
    { name: metadataFile, mimeType: 'text/plain', buffer: Buffer.from('Description and label fixture') },
  ]);
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploaded', { exact: true })).toHaveCount(3);
  await action(page, metadataFile, 'Open');
  const panel = page.getByRole('complementary', { name: 'Preview' });
  await panel.getByRole('button', { name: 'Details', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Description', exact: true }).fill(`Descriptive ${marker} note`);
  await panel.getByRole('textbox', { name: 'Labels', exact: true }).fill(`${marker}-label`);
  await panel.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Save details', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search this space', exact: true }).fill(marker);
  const filter = page.getByRole('combobox', { name: 'Filter search matches' });
  await expect(page.getByRole('button', { name: `Actions for ${nameFile}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for ${bodyFile}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for ${metadataFile}` })).toBeVisible();
  await expect(page.getByText(/Showing 3 of 3 returned matches/)).toBeVisible();
  await filter.selectOption('content');
  await expect(page.getByRole('button', { name: `Actions for ${bodyFile}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for ${nameFile}` })).toBeHidden();
  await expect(page.getByRole('grid', { name: 'Files' }).getByText(body, { exact: true })).toBeVisible();
  await filter.selectOption('metadata');
  await expect(page.getByRole('button', { name: `Actions for ${metadataFile}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for ${bodyFile}` })).toBeHidden();
  await page.getByRole('textbox', { name: 'Search this space', exact: true }).fill(`${marker}-label`);
  await expect(page.getByRole('row', { name: new RegExp(metadataFile) })).toContainText(`${marker}-label`);
  await page.getByRole('textbox', { name: 'Search this space', exact: true }).fill(`Descriptive ${marker}`);
  await expect(page.getByRole('row', { name: new RegExp(metadataFile) })).toContainText('Descriptive');
  await page.getByRole('textbox', { name: 'Search this space', exact: true }).fill(marker);
  await filter.selectOption('metadata');
  await expect(page.getByRole('button', { name: `Actions for ${metadataFile}` })).toBeVisible();
  await action(page, metadataFile, 'Open');
  await expect(panel.getByRole('heading', { name: metadataFile, exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await filter.selectOption('name');
  await expect(page.getByRole('button', { name: `Actions for ${nameFile}` })).toBeVisible();
  await action(page, nameFile, 'Open');
  await expect(panel.getByText('Name-only match', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await filter.selectOption('all');
  await page.getByRole('button', { name: 'Search or jump to', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Command Palette', exact: true });
  await palette.getByRole('combobox').fill(marker);
  await expect(palette.getByRole('option', { name: new RegExp(nameFile) })).toBeVisible();
  await expect(palette.getByRole('option', { name: new RegExp(metadataFile) })).toBeVisible();
  const bodyOption = palette.getByRole('option', { name: new RegExp(bodyFile) });
  await expect(bodyOption).toContainText(marker);
  for (let press = 0; press < 5 && await bodyOption.getAttribute('aria-selected') !== 'true'; press++) await page.keyboard.press('ArrowDown');
  await expect(bodyOption).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { name: bodyFile, exact: true })).toBeVisible();
  await expect(panel.getByText(body, { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await page.getByRole('row', { name: new RegExp(nameFile) }).getByRole('checkbox').check();
  await page.route('**/api/search?*', route => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText("Couldn't load this view", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Actions for ${nameFile}` })).toBeHidden();
  await expect(page.getByRole('status', { name: 'Selection status' })).toContainText('Selection cleared');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText(/Showing 3 of 3 returned matches/)).toBeVisible();
  const spaces = await openSpaces(page);
  await spaces.getByRole('button', { name: 'Close', exact: true }).click();
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Manage Acceptance Drive', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Space plugins', exact: true }).click();
  const plugins = page.getByRole('dialog', { name: 'Plugins', exact: true });
  await plugins.getByRole('button', { name: 'Personal installs', exact: true }).click();
  await plugins.getByRole('button', { name: 'Review Image Viewer', exact: true }).click();
  await plugins.getByRole('checkbox', { name: /Approve the capabilities/ }).check();
  page.once('dialog', dialog => dialog.accept());
  await plugins.getByRole('button', { name: 'Install plugin', exact: true }).click();
  const installed = plugins.locator('section').filter({ has: page.getByRole('heading', { name: 'Image Viewer', exact: true }) }).filter({ hasText: 'Installed for you' });
  const toggle = installed.getByRole('button', { name: /^(Enable|Disable)$/ });
  await expect(toggle).toBeEnabled();
  if (await toggle.textContent() === 'Enable') await toggle.click();
  await plugins.getByRole('button', { name: 'All installs', exact: true }).click();
  const enabled: { name: string; personal: boolean }[] = [];
  for (const row of await plugins.locator('section').filter({ has: page.getByRole('button', { name: 'Disable', exact: true }) }).all()) {
    enabled.push({ name: await row.getByRole('heading').innerText(), personal: await row.getByText('Installed for you', { exact: true }).isVisible() });
  }
  const installRow = (item: { name: string; personal: boolean }) => plugins.locator('section')
    .filter({ has: page.getByRole('heading', { name: item.name, exact: true }) })
    .filter({ hasText: item.personal ? 'Installed for you' : 'Applied to Acceptance Drive' });
  const restore = async () => {
    if (!await plugins.isVisible()) {
      if (await palette.isVisible()) await page.keyboard.press('Escape');
      if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByRole('button', { name: 'Manage Acceptance Drive', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Space plugins', exact: true }).click();
    }
    // A reopened dialog renders its rows asynchronously: wait for each toggle before reading it.
    for (const item of enabled) {
      await expect(installRow(item).getByRole('button', { name: /^(Enable|Disable)$/ })).toBeEnabled();
      const enable = installRow(item).getByRole('button', { name: 'Enable', exact: true });
      if (await enable.isVisible()) await enable.click();
      await expect(installRow(item).getByRole('button', { name: 'Disable', exact: true })).toBeEnabled();
    }
    await expect(plugins.getByRole('button', { name: /^(Enable|Disable) image viewer$/ })).toBeVisible();
    const enableViewer = plugins.getByRole('button', { name: 'Enable image viewer', exact: true });
    if (await enableViewer.isVisible()) await enableViewer.click();
    await expect(plugins.getByRole('button', { name: 'Disable image viewer', exact: true })).toBeVisible();
    await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  };
  // The space is shared with later specs: re-enable everything even when an assertion fails.
  try {
    for (const item of enabled) {
      await installRow(item).getByRole('button', { name: 'Disable', exact: true }).click();
      await expect(installRow(item).getByRole('button', { name: 'Enable', exact: true })).toBeEnabled();
    }
    await expect(plugins.getByRole('button', { name: 'Disable', exact: true })).toHaveCount(0);
    await plugins.getByRole('button', { name: 'Disable image viewer', exact: true }).click();
    await plugins.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Search this space', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText(/Showing 3 of 3 returned matches/)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').fill(marker);
    await expect(palette.getByRole('option', { name: new RegExp(bodyFile) })).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await restore();
  }
});

test('another account cannot discover or open files outside its space membership', async ({ page, browser }, info) => {
  const prefix = info.project.name;
  const protectedName = `${prefix} Private search space`;
  const marker = `secret${prefix}search`;
  const privateName = `${marker}.txt`;
  const recipientContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    await signIn(page);
    await createSpace(page, protectedName);
    await upload(page, privateName, marker);
    const protectedSlug = await page.evaluate(() => localStorage.getItem('canopy.site'));
    const listing = await (await page.request.get('/api/folders/root/files', { headers: { 'x-site': protectedSlug! } })).json();
    const privateId = listing.find((file: { name: string }) => file.name === privateName).id;
    await switchSpace(page, 'Acceptance Drive');
    const recipient = await recipientContext.newPage();
    await acceptInvitation(recipient, await invite(page, `${prefix}-restricted@canopy.test`, 'viewer'), `${prefix} restricted`, 'Acceptance Drive');
    await recipient.getByRole('textbox', { name: 'Search this space', exact: true }).fill(marker);
    await expect(recipient.getByRole('heading', { name: `No matches for “${marker}”`, exact: true })).toBeVisible();
    await expect(recipient.getByRole('button', { name: `Actions for ${privateName}` })).toBeHidden();
    const spaces = await openSpaces(recipient);
    await expect(spaces.getByRole('button', { name: `Open ${protectedName}`, exact: true })).toBeHidden();
    // Positive control: the same session is authenticated and may search its own space,
    // so the 401s below are refusals rather than a missing session.
    // Acceptance Drive is the hostname's home space, so no x-site is needed to reach it.
    const allowed = await recipient.request.get(`/api/search?term=${marker}`);
    expect(allowed.status()).toBe(200);
    const search = await recipient.request.get(`/api/search?term=${marker}`, { headers: { 'x-site': protectedSlug! } });
    expect(search.status()).toBe(401);
    const content = await recipient.request.get(`/api/files/${privateId}/content?site=${protectedSlug}`);
    expect(content.status()).toBe(401);
  } finally { await recipientContext.close(); }
});
