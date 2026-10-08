import { test, expect } from '@playwright/test';
import { signIn, createFolder, action } from './support';

function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('text saves create versions and a concurrent browser write preserves the conflicting draft', async ({ page, context }, info) => {
  const folder = `${info.project.name} Preview text`;
  const name = 'acceptance-text.txt';
  const original = 'Original preview text';
  const changed = 'Changed in another browser tab';
  const draft = 'My unsaved draft';
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(original) });
  await action(page, name, 'Open');
  const panel = page.getByRole('complementary', { name: 'Preview' });
  await expect(panel.getByText(original, { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(panel.locator('section[aria-label="File information"]').getByText(name, { exact: true })).toBeVisible();
  await expect(panel.locator('section[aria-label="File information"]').getByText('text/plain', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Preview', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit text', exact: true }).click();
  await panel.getByRole('textbox', { name: 'File text' }).fill(draft);
  const other = await context.newPage();
  await other.goto('/');
  await action(other, folder, 'Open');
  await other.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(changed) });
  await expect(other.getByRole('region', { name: 'Uploads' }).getByText('Uploaded', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('This file changed');
  await expect(panel.getByRole('textbox', { name: 'File text' })).toHaveValue(draft);
  await panel.getByRole('button', { name: 'Reload latest', exact: true }).click();
  await panel.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'File text' })).toHaveValue(draft);
  await panel.getByRole('button', { name: 'Reload latest', exact: true }).click();
  await panel.getByRole('button', { name: 'Discard edits and reload', exact: true }).click();
  await expect(panel.getByText(changed, { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Edit text', exact: true }).click();
  await panel.getByRole('textbox', { name: 'File text' }).fill('Accepted browser edit');
  await panel.getByRole('button', { name: 'Save text', exact: true }).click();
  await expect(panel.getByText('Accepted browser edit', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Versions', exact: true }).click();
  await expect(panel.getByRole('link', { name: /Download version/ })).toHaveCount(3);
  await expect(panel.getByText('current', { exact: true })).toHaveCount(1);
  await other.close();
});

test('image, PDF, installed viewer and unsupported fallback stay usable within the viewport', async ({ page }, info) => {
  const folder = `${info.project.name} Preview media`;
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3cAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'acceptance.png', mimeType: 'image/png', buffer: png },
    { name: 'acceptance.pdf', mimeType: 'application/pdf', buffer: pdf() },
    { name: 'acceptance.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) },
  ]);
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploaded', { exact: true })).toHaveCount(3);
  const panel = page.getByRole('complementary', { name: 'Preview' });
  await action(page, 'acceptance.png', 'Open');
  const image = panel.getByRole('img', { name: 'acceptance.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  await panel.getByRole('button', { name: 'Close preview' }).click();
  await action(page, 'acceptance.pdf', 'Open');
  await expect(panel.locator('object[type="application/pdf"]')).toHaveAttribute('data', /\/api\/files\/.+\/content/);
  const box = (await panel.locator('object').boundingBox())!;
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await panel.getByRole('button', { name: 'Close preview' }).click();
  await action(page, 'acceptance.bin', 'Open');
  await expect(panel.getByText(/No preview for application\/octet-stream/)).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close preview' }).click();
  if (page.viewportSize()!.width < 768) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Manage Acceptance Drive', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Space plugins', exact: true }).click();
  const plugins = page.getByRole('dialog', { name: 'Plugins', exact: true });
  await plugins.getByRole('button', { name: 'Review Image Viewer', exact: true }).click();
  await plugins.getByRole('checkbox', { name: /Approve the capabilities/ }).check();
  page.once('dialog', dialog => dialog.accept()); // Mobile replaces this run's desktop install.
  await plugins.getByRole('button', { name: 'Install plugin', exact: true }).click();
  await expect(plugins.locator('section').filter({ has: page.getByRole('heading', { name: 'Image Viewer', exact: true }) }).getByRole('button', { name: 'Disable', exact: true })).toBeVisible();
  await plugins.getByRole('button', { name: 'Close', exact: true }).click();
  await action(page, 'acceptance.png', 'Open');
  await panel.getByRole('combobox', { name: 'Open with' }).selectOption({ label: 'Image Viewer' });
  const installedImage = page.frameLocator('iframe[title="Image Viewer"]').getByRole('img', { name: 'acceptance.png', exact: true });
  await expect(installedImage).toBeVisible();
  await expect.poll(() => installedImage.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('failed metadata, body and history reads each recover from the preview', async ({ page }, info) => {
  const folder = `${info.project.name} Preview retries`;
  const name = 'retry.txt';
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Retry reads real bytes') });
  const panel = page.getByRole('complementary', { name: 'Preview' });
  for (const path of ['**/api/files/*', '**/api/files/*/versions/*/content*', '**/api/files/*/versions*']) {
    await page.route(path, route => route.abort('failed'), { times: 1 });
    await action(page, name, 'Open');
    if (path.endsWith('/versions*')) await panel.getByRole('button', { name: 'Versions', exact: true }).click();
    await panel.getByRole('button', { name: 'Retry preview', exact: true }).click();
    if (path.endsWith('/versions*')) await expect(panel.getByRole('link', { name: /Download version/ })).toHaveCount(1);
    else await expect(panel.getByText('Retry reads real bytes', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Close preview' }).click();
  }
});

test('switching files during a real delayed metadata read cannot display the previous file details', async ({ page }, info) => {
  const folder = `${info.project.name} Preview identity`;
  await signIn(page);
  await createFolder(page, folder);
  await action(page, folder, 'Open');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'a-first.txt', mimeType: 'text/plain', buffer: Buffer.from('First file contents') },
    { name: 'b-second.txt', mimeType: 'text/plain', buffer: Buffer.from('Second file contents') },
  ]);
  await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Uploaded', { exact: true })).toHaveCount(2);
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/files/*', async route => {
    started();
    await delayed;
    await route.continue();
  }, { times: 1 });
  await action(page, 'a-first.txt', 'Open');
  await waiting;
  const panel = page.getByRole('complementary', { name: 'Preview' });
  try {
    await panel.getByRole('button', { name: 'Next file', exact: true }).click();
    await expect(panel.getByText('Second file contents', { exact: true })).toBeVisible();
  } finally { release(); }
  await panel.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(panel.locator('section[aria-label="File information"]').getByText('b-second.txt', { exact: true })).toBeVisible();
  await expect(panel.locator('section[aria-label="File information"]').getByText('a-first.txt', { exact: true })).toBeHidden();
  await panel.getByRole('button', { name: 'Versions', exact: true }).click();
  await expect(panel.getByRole('link', { name: /Download version/ })).toHaveCount(1);
});
