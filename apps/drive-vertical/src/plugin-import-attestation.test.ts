import { expect, it, vi } from 'vitest';
import { signPluginImport, verifyPluginImport } from './plugin-import-attestation';

const manifest = {id:'sample',name:'Sample',version:'1.0.0',capabilities:[],contributes:{detailView:{id:'main',title:'Sample'}}};
const source = 'export default function render() {}';

it('accepts only the imported source and manifest for the same principal and space', async () => {
  const token = await signPluginImport('secret', {principal:'person-a',scope:'space-a',kind:'npm',ref:'sample@latest',resolved:'1.0.0 sha512-test',manifest,source});
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', manifest, source)).toEqual({kind:'npm',ref:'sample@latest',resolved:'1.0.0 sha512-test'});
  expect(await verifyPluginImport('secret', token, 'person-b', 'space-a', manifest, source)).toBeNull();
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-b', manifest, source)).toBeNull();
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', manifest, source + '/* edited */')).toBeNull();
  expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', {...manifest,name:'Changed'}, source)).toBeNull();
  expect(await verifyPluginImport('other-secret', token, 'person-a', 'space-a', manifest, source)).toBeNull();
});

it('expires an import claim', async () => {
  vi.useFakeTimers();
  try {
    const token = await signPluginImport('secret', {principal:'person-a',scope:'space-a',kind:'github',ref:'owner/repo@main',resolved:'commit',manifest,source});
    vi.advanceTimersByTime(16 * 60_000);
    expect(await verifyPluginImport('secret', token, 'person-a', 'space-a', manifest, source)).toBeNull();
  } finally { vi.useRealTimers(); }
});
