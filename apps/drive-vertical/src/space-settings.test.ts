import { expect, it } from 'vitest';
import { defaultSpaceSettings, parseSpaceSettings, provisionSpaceSettings, spaceSettingsSchema } from './space-settings';
it('validates bounded space presentation metadata', () => {
  expect(spaceSettingsSchema.parse({...defaultSpaceSettings('Family'),name:' Family '})).toEqual(defaultSpaceSettings('Family'));
  expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings(''),name:'  '}).success).toBe(false);
  expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings('Family'),color:'url(https://attacker.test)'}).success).toBe(false);
  expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings('Family'),icon:'unknown'}).success).toBe(false);
});

it('tolerates obsolete or malformed persisted settings and rejects deceptive names', () => {
 expect(parseSpaceSettings('not json')).toBeNull();expect(parseSpaceSettings('{"name":"Family","icon":"obsolete","color":"#3b82f6"}')).toBeNull();
 for(const name of ['\u202eFamily','Family\nTeam','\u200b'])expect(spaceSettingsSchema.safeParse({...defaultSpaceSettings(name)}).success).toBe(false);
});
it('moves creator settings once, cleans the handoff and preserves renamed settings on reconcile',async()=>{
 const rows=new Map([['creator:owner',defaultSpaceSettings('Family')]]);
 const directory={readSpaceSettings:async(key:string)=>rows.get(key)??null,writeSpaceSettings:async(key:string,value:ReturnType<typeof defaultSpaceSettings>)=>{rows.set(key,value);},deleteSpaceSettings:async(key:string)=>{rows.delete(key);},recordSite:async()=>{},listSites:async()=>[]};
 expect(await provisionSpaceSettings(directory,'scope','owner')).toEqual(defaultSpaceSettings('Family'));expect(rows.has('creator:owner')).toBe(false);rows.set('scope',defaultSpaceSettings('Renamed'));expect((await provisionSpaceSettings(directory,'scope','owner'))?.name).toBe('Renamed');
});
