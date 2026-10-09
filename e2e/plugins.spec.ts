import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { signIn, createFolder, action, upload } from './support';

const { zipSync } = createRequire(new URL('../packages/plugin-sources/package.json', import.meta.url))('fflate') as {
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array;
};
function archive(manifest: object, source: string) {
  const encode = (text: string) => new TextEncoder().encode(text);
  return Buffer.from(zipSync({ 'canopy.json': encode(JSON.stringify(manifest)), 'index.js': encode(source) }));
}
async function openPlugins(page: Page) {
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Manage Acceptance Drive', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Space plugins', exact: true }).click();
  return page.getByRole('dialog', { name: 'Plugins', exact: true });
}
async function installReviewed(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Plugins', exact: true });
  await expect(dialog.getByRole('button', { name: 'Install plugin', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Approve the capabilities/ }).check();
  await dialog.getByRole('button', { name: 'Install plugin', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Plugin source', exact: true })).toHaveValue('');
}

test('catalog personal and space installs each require approval and retain their separate controls', async ({ page }) => {
  await signIn(page);
  page.on('dialog', dialog => dialog.accept()); // Replace only synthetic installs from this run.
  const plugins = await openPlugins(page);
  await plugins.getByRole('button', { name: 'Review Image Viewer', exact: true }).click();
  await expect(plugins.getByRole('checkbox', { name: 'Apply to Acceptance Drive', exact: true })).not.toBeChecked();
  await installReviewed(page);
  await plugins.getByRole('button', { name: 'Apply Image Viewer to Acceptance Drive', exact: true }).click();
  await expect(plugins.getByRole('checkbox', { name: 'Apply to Acceptance Drive', exact: true })).toBeChecked();
  await installReviewed(page);
  const images = plugins.locator('section').filter({ has: page.getByRole('heading', { name: 'Image Viewer', exact: true }) });
  await plugins.getByRole('button', { name: 'Personal installs', exact: true }).click();
  await expect(images.getByRole('button', { name: 'Disable', exact: true })).toHaveCount(1);
  await expect(images.getByText('Installed for you', { exact: true })).toBeVisible();
  await images.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(images.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await images.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(images.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await plugins.getByRole('button', { name: 'Space installs', exact: true }).click();
  await expect(images.getByRole('button', { name: 'Disable', exact: true })).toHaveCount(1);
  await expect(images.getByText('Applied to Acceptance Drive', { exact: true })).toBeVisible();
  await images.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(images.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await images.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(images.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
});

test('a ZIP app follows enable/disable in the rail and palette; editing keeps its install and building creates another', async ({ page }, info) => {
  const name = `Acceptance app ${info.project.name}`;
  const manifest = { id: `acceptance-app-${info.project.name}`, name, version: '1.0.0', capabilities: [], contributes: { detailView: { id: 'main', title: name } } };
  await signIn(page);
  page.on('dialog', dialog => dialog.accept());
  const plugins = await openPlugins(page);
  await plugins.getByRole('button', { name: 'Personal installs', exact: true }).click();
  await plugins.getByText('Plugin Studio · import or edit source', { exact: true }).click();
  await plugins.getByRole('button', { name: 'All installs', exact: true }).click();
  await plugins.getByLabel('Choose plugin ZIP file').setInputFiles({ name: 'app.zip', mimeType: 'application/zip', buffer: archive(manifest, 'export default function render({container}) { container.textContent = "ZIP app is running"; }') });
  await installReviewed(page);
  const installed = plugins.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await installed.getByRole('button', { name: 'Open app', exact: true }).click();
  await expect(page.frameLocator(`iframe[title="${name}"]`).getByText('ZIP app is running', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to drive', exact: true }).click();
  await openPlugins(page);
  await installed.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(installed.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Views', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name, exact: true })).not.toBeAttached();
  if (page.viewportSize()!.width < 768) await page.getByRole('dialog', { name: 'Drive navigation', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command Palette', exact: true });
  await palette.getByRole('combobox').fill(name);
  await expect(palette.getByRole('option', { name, exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await openPlugins(page);
  await installed.getByRole('button', { name: 'Enable', exact: true }).click();
  await installed.getByRole('button', { name: 'Edit source', exact: true }).click();
  await plugins.getByRole('textbox', { name: 'Plugin source', exact: true }).fill('export default function render({container}) { container.textContent = "Edited existing app"; }');
  await expect(plugins.getByRole('button', { name: 'Save plugin changes', exact: true })).toBeDisabled();
  await plugins.getByRole('checkbox', { name: /Approve the capabilities/ }).check();
  await plugins.getByRole('button', { name: 'Save plugin changes', exact: true }).click();
  await expect(plugins.getByRole('textbox', { name: 'Plugin source', exact: true })).toHaveValue('');
  await expect(installed.getByRole('button', { name: 'Edit source', exact: true })).toHaveCount(1);
  await installed.getByRole('button', { name: 'Open app', exact: true }).click();
  await expect(page.frameLocator(`iframe[title="${name}"]`).getByText('Edited existing app', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to drive', exact: true }).click();
  await openPlugins(page);
  await plugins.getByRole('button', { name: 'Build a plugin', exact: true }).click();
  const created = JSON.parse(await plugins.getByRole('textbox', { name: 'Plugin manifest', exact: true }).inputValue());
  created.id = `${info.project.name}-new-plugin`; created.name = `${info.project.name} New plugin`;
  await plugins.getByRole('textbox', { name: 'Plugin manifest', exact: true }).fill(JSON.stringify(created));
  await installReviewed(page);
  await expect(installed.getByRole('button', { name: 'Edit source', exact: true })).toHaveCount(1);
  await expect(plugins.getByRole('heading', { name: created.name, exact: true })).toHaveCount(1);
  await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox').fill(name);
  await palette.getByRole('option', { name, exact: true }).click();
  await expect(page.frameLocator(`iframe[title="${name}"]`).getByText('Edited existing app', { exact: true })).toBeVisible();
});

test('public GitHub imports pin provenance and malformed ZIP/npm imports keep installation unavailable', async ({ page }) => {
  await signIn(page);
  page.on('dialog', dialog => dialog.accept());
  const plugins = await openPlugins(page);
  await plugins.getByRole('button', { name: 'Personal installs', exact: true }).click();
  await plugins.getByText('Plugin Studio · import or edit source', { exact: true }).click();
  await plugins.getByLabel('Choose plugin ZIP file').setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid archive') });
  await expect(plugins.getByRole('alert').filter({ hasText: /zip|archive/i })).toBeVisible();
  await expect(plugins.getByRole('button', { name: 'Install plugin', exact: true })).toBeDisabled();
  await plugins.getByRole('textbox', { name: 'GitHub repository', exact: true }).fill('markusahlstrand/canopy');
  await plugins.getByRole('textbox', { name: 'GitHub ref', exact: true }).fill('e192c2c');
  await plugins.getByRole('textbox', { name: 'GitHub plugin folder', exact: true }).fill('examples/plugins/image-viewer');
  await plugins.getByRole('button', { name: 'Review GitHub plugin', exact: true }).click();
  await expect(plugins.getByRole('textbox', { name: 'Plugin source', exact: true })).toHaveValue(/export default function render/);
  await installReviewed(page);
  const row = plugins.locator('section').filter({ has: page.getByRole('heading', { name: 'Image Viewer', exact: true }) });
  await expect(row.getByText(/Source: github/)).toBeVisible();
  await plugins.getByRole('textbox', { name: 'npm package', exact: true }).fill('react');
  await plugins.getByRole('textbox', { name: 'npm version or tag', exact: true }).fill('19.3.0');
  await plugins.getByRole('button', { name: 'Review npm plugin', exact: true }).click();
  await expect(plugins.getByRole('alert').filter({ hasText: /no canopy manifest/ })).toBeVisible();
  await expect(plugins.getByRole('button', { name: 'Install plugin', exact: true })).toBeDisabled();
});

test('a ZIP editor retries byte failures and native iframe interaction is blocked until its save finishes', async ({ page }, info) => {
  const name = `Acceptance editor ${info.project.name}`;
  const manifest = { id: `acceptance-editor-${info.project.name}`, name, version: '1.0.0', capabilities: [{ kind: 'item:read' }, { kind: 'item:write' }], contributes: { viewers: [{ id: 'text', title: name, match: ['text/*'] }] } };
  const source = `export default function render({container,file,emit}) {
    const input=document.createElement('textarea'); input.setAttribute('aria-label','Plugin text'); input.value=new TextDecoder().decode(file.bytes);
    input.addEventListener('input',()=>emit('dirty',{dirty:true}));
    const save=document.createElement('button'); save.textContent='Save plugin text'; save.onclick=()=>emit('save',{content:input.value});
    container.append(input,save);
  }`;
  await signIn(page);
  const folder = `${info.project.name} Plugin editor`;
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await upload(page, 'plugin.txt', 'Original plugin text');
  const plugins = await openPlugins(page);
  await plugins.getByRole('button', { name: 'Personal installs', exact: true }).click();
  await plugins.getByText('Plugin Studio · import or edit source', { exact: true }).click();
  await plugins.getByLabel('Choose plugin ZIP file').setInputFiles({ name: 'editor.zip', mimeType: 'application/zip', buffer: archive(manifest, source) });
  await installReviewed(page);
  await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  await action(page, 'plugin.txt', 'Open');
  const panel = page.getByRole('complementary', { name: 'Preview' });
  await expect(panel.getByText('Original plugin text', { exact: true })).toBeVisible();
  await page.route('**/api/files/*/versions/*/content*', route => route.abort('failed'), { times: 1 });
  await panel.getByRole('combobox', { name: 'Open with' }).selectOption({ label: name });
  await panel.getByRole('button', { name: 'Retry plugin', exact: true }).click();
  const frame = page.frameLocator(`iframe[title="${name}"]`);
  await expect(frame.getByRole('textbox', { name: 'Plugin text' })).toHaveValue('Original plugin text');
  await frame.getByRole('textbox', { name: 'Plugin text' }).fill('Saved through the real plugin bridge');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/files\/[^/]+\/content\?expectedVersion=/, async route => { await pending; await route.continue(); }, { times: 1 });
  await frame.getByRole('button', { name: 'Save plugin text', exact: true }).click();
  try {
    await expect(frame.locator('#root')).toHaveJSProperty('inert', true);
    expect(await frame.getByRole('textbox', { name: 'Plugin text' }).evaluate((input: HTMLTextAreaElement) => { input.focus(); return document.activeElement === input; })).toBe(false);
  } finally { release(); }
  await expect(frame.getByRole('textbox', { name: 'Plugin text' })).toHaveValue('Saved through the real plugin bridge');
  await expect(frame.locator('#root')).toHaveJSProperty('inert', false);
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await openPlugins(page);
  const installed = plugins.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await installed.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(installed.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
  await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  await action(page, 'plugin.txt', 'Open');
  await expect(panel.getByText('Saved through the real plugin bridge', { exact: true })).toBeVisible();
  await expect(panel.getByRole('option', { name, exact: true })).not.toBeAttached();
  await panel.getByRole('button', { name: 'Close preview', exact: true }).click();
  await openPlugins(page);
  await installed.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(installed.getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  await action(page, 'plugin.txt', 'Open');
  await expect(panel.getByRole('option', { name, exact: true })).toBeAttached();
});
