import {afterEach,expect,it,vi} from 'vitest';
import {importGithubPlugin} from './github-plugin-import';

vi.mock('@canopy/plugin-sources',()=>({resolvePlugin:async()=>({
  manifest:{id:'sample',name:'Sample',version:'1.0.0'},
  entry:{url:'https://raw.githubusercontent.com/owner/repo/0123456789012345678901234567890123456789/index.js'},
  version:'0123456789012345678901234567890123456789',
})}));
afterEach(()=>vi.unstubAllGlobals());

it('returns pinned GitHub provenance with bounded source',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('export default () => {}')));
  const result=await importGithubPlugin({repo:'owner/repo',ref:'main'});
  expect(result.source).toContain('export default');
  expect(result.provenance).toEqual({kind:'github',ref:'owner/repo@main',resolved:'0123456789012345678901234567890123456789'});
});
it('rejects an oversized GitHub entry before reading it',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('x',{headers:{'content-length':'256001'}})));
  await expect(importGithubPlugin({repo:'owner/repo'})).rejects.toThrow('too large');
});
