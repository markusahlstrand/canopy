import { expect, it } from 'vitest';
import { defaultSpaceSettings, spaceSettingsSchema } from './space-settings';
it('validates bounded space presentation metadata', () => {
  expect(spaceSettingsSchema.parse({...defaultSpaceSettings('Family'),name:' Family '})).toEqual(defaultSpaceSettings('Family'));
  expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings(''),name:'  '}).success).toBe(false);
  expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings('Family'),color:'url(https://attacker.test)'}).success).toBe(false);
  expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings('Family'),icon:'unknown'}).success).toBe(false);
});
