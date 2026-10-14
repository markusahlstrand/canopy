import { test, expect } from '@playwright/test';
import { signIn } from './support';
import { createSpace, openSpaces, openMembers, invite } from './spaces';
import { acceptInvitation } from './recipients';

// Real accepted members, seen from both sides: the owner's roster and each recipient's shell.
test('accepted viewer and editor members appear in the roster and see only the shell actions their role allows', async ({ page, browser }, info) => {
  const prefix = info.project.name;
  const space = `${prefix} Member shell`;
  const viewerContext = await browser.newContext({ viewport: page.viewportSize() });
  const editorContext = await browser.newContext({ viewport: page.viewportSize() });
  try {
    await signIn(page);
    await createSpace(page, space);
    const viewerUrl = await invite(page, `${prefix}-viewer@canopy.test`, 'viewer');
    const editorUrl = await invite(page, `${prefix}-editor@canopy.test`, 'editor');
    const viewer = await viewerContext.newPage();
    const editor = await editorContext.newPage();
    await acceptInvitation(viewer, viewerUrl, `${prefix} viewer`, space);
    await acceptInvitation(editor, editorUrl, `${prefix} editor`, space);

    // The owner now sees two people, not two open invitations.
    const people = await openMembers(page);
    for (const role of ['viewer', 'editor']) {
      await expect(people.getByRole('button', { name: `Remove ${prefix} ${role}`, exact: true })).toBeVisible();
      await expect(people.getByRole('button', { name: `Withdraw the invitation for ${prefix}-${role}@canopy.test`, exact: true })).toBeHidden();
    }
    await people.getByRole('button', { name: 'Close', exact: true }).click();

    // Recipients land in the invited space, and the picker offers no owner-only management.
    for (const member of [viewer, editor]) {
      const spaces = await openSpaces(member);
      await expect(spaces.getByText('Current space', { exact: true })).toBeVisible();
      await expect(spaces.getByRole('button', { name: 'Manage members', exact: true })).toBeHidden();
      await expect(spaces.getByRole('button', { name: 'Space settings', exact: true })).toBeHidden();
      await expect(spaces.getByRole('button', { name: 'Create space', exact: true })).toBeHidden();
      await spaces.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally { await viewerContext.close(); await editorContext.close(); }
});
