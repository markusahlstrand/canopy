import { expect, test } from '@playwright/test';
import { createFolder, nav, revealRow, signIn } from './support';
import { createSpace, switchSpace } from './spaces';

/** Where a run leaves screenshots of the canvas, when asked to (`FLOW_SHOTS=/some/dir`). */
const shots = process.env.FLOW_SHOTS;

test('a flow drawn on the canvas copies what arrives in one space into another', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'The canvas is drawn on a desktop; a phone only reads the list.');
  const n = Date.now().toString(36);
  const target = `Gestoria ${n}`;
  await signIn(page);
  await createSpace(page, target);
  await createFolder(page, 'Bancos');
  await switchSpace(page, 'Acceptance Drive');

  await nav(page, 'Flows');
  // One dialog: its title follows what it shows (Flows, New flow).
  const flows = page.getByRole('dialog');
  await flows.getByRole('button', { name: /New flow/ }).click();
  await flows.getByLabel('Flow name').fill(`Statements ${n}`);

  // A new flow starts watching the space this tab is in.
  await expect(flows.locator('.react-flow__node').filter({ hasText: 'When a document arrives in Acceptance Drive' })).toBeVisible();

  // Check: a file type nothing else here has. Yes: copy it into the other space.
  await flows.getByRole('button', { name: 'Add a check' }).click();
  await flows.getByLabel('What to check').selectOption('extension');
  await flows.getByLabel('File types').fill(`flow${n}`);
  await flows.getByLabel('File types').blur();
  await flows.getByRole('button', { name: 'Add a copy' }).click();
  await flows.getByLabel('Space to copy to').selectOption({ label: target });
  await expect(flows.getByLabel('Folder to copy to').getByRole('option', { name: 'Bancos' })).toBeAttached();
  await flows.getByLabel('Folder to copy to').selectOption({ label: 'Bancos' });
  await expect(flows.locator('.react-flow__node').filter({ hasText: `Copy to ${target} › Bancos` })).toBeVisible();
  if (shots) { await page.waitForTimeout(1500); await page.screenshot({ path: `${shots}/flow-canvas.png` }); }

  await flows.getByRole('button', { name: 'Save flow' }).click();
  await expect(flows.getByText('Flow saved.')).toBeVisible();
  // Listed with the spaces it touches.
  const row = flows.getByRole('listitem').filter({ hasText: `Statements ${n}` });
  await expect(row).toContainText('Acceptance Drive');
  await expect(row).toContainText(target);
  if (shots) await page.screenshot({ path: `${shots}/flow-list.png` });
  await page.keyboard.press('Escape');

  const name = `statement-${n}.flow${n}`;
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Account statement') });
  await revealRow(page, name);

  await switchSpace(page, target);
  await page.getByRole('row').filter({ hasText: 'Bancos' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Bancos' })).toBeVisible();
  // The copy lands after the response, as the run is driven: look again until it is there.
  await expect.poll(async () => {
    await page.getByRole('button', { name: 'Refresh' }).first().click().catch(() => {});
    return page.getByRole('row').filter({ hasText: name }).count();
  }, { timeout: 60_000, intervals: [2_000] }).toBe(1);
  if (shots) await page.screenshot({ path: `${shots}/flow-copied.png` });
});
