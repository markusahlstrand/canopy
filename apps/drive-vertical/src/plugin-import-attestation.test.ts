import { expect, it } from 'vitest';
import { signPluginImport, verifyPluginImport } from './plugin-import-attestation';

const manifest = {id:'sample',name:'Sample',version:'1.0.0',capabilities:[],contributes:{detailView:{id:'main',title:'Sample'}}};
const source = 'export default function render() {}';
const now = 1_000_000;

it('accepts only the imported source and manifest for the same principal and space', async () => {
  const token = await signPluginImport('secret', {principal:'person-a',scope:'space-a',kind:'npm',ref:'sample@latest',resolved:'1.0.0 sha512-test',manifest,source}, now);
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', manifest, source, now)).toEqual({kind:'npm',ref:'sample@latest',resolved:'1.0.0 sha512-test'});
  expect(await verifyPluginImport('secret', token, 'person-b', 'space-a', manifest, source, now)).toBeNull();
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-b', manifest, source, now)).toBeNull();
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', manifest, source + '/* edited */', now)).toBeNull();
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', {...manifest,name:'Changed'}, source, now)).toBeNull();
  expect(await verifyPluginImport('other-secret', token, 'person-a', 'space-a', manifest, source, now)).toBeNull();
});

it('expires an import claim', async () => {
  const token = await signPluginImport('secret', {principal:'person-a',scope:'space-a',kind:'github',ref:'owner/repo@main',resolved:'commit',manifest,source}, now);
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', manifest, source, now + 16 * 60_000)).toBeNull();
});
