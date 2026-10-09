import { expect, type Page } from '@playwright/test';

export async function openSpaces(page: Page) {
  await page.getByRole('button', { name: /^Spaces, current:/ }).click();
  return page.getByRole('dialog', { name: 'Spaces', exact: true });
}
export async function createSpace(page: Page, name: string) {
  const spaces = await openSpaces(page);
  await spaces.getByRole('button', { name: 'Create space', exact: true }).click();
  const creation = page.getByRole('dialog', { name: 'Create a space', exact: true });
  await creation.getByRole('textbox', { name: 'Space name', exact: true }).fill(name);
  await creation.getByRole('button', { name: 'Create space', exact: true }).click();
  await expect(page.getByRole('button', { name: `Spaces, current: ${name}`, exact: true })).toBeVisible();
}
export async function switchSpace(page: Page, name: string) {
  const spaces = await openSpaces(page);
  await spaces.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Spaces, current: ${name}`, exact: true })).toBeVisible();
}
export async function openMembers(page: Page) {
  const spaces = await openSpaces(page);
  await spaces.getByRole('button', { name: 'Manage members', exact: true }).click();
  return page.getByRole('dialog', { name: 'People', exact: true });
}
export async function invite(page: Page, email: string, role: string) {
  const people = await openMembers(page);
  await people.getByRole('combobox', { name: 'Email', exact: true }).fill(email);
  await people.getByRole('combobox', { name: 'Invitation role' }).selectOption(role);
  await people.getByRole('button', { name: 'Invite', exact: true }).click();
  const url = await people.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  expect(url).toContain('invite=');
  await people.getByRole('button', { name: 'Close', exact: true }).click();
  return url;
}
