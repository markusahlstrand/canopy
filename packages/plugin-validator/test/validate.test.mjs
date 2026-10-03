import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePlugin } from '../src/index.mjs';
const manifest = { id: 'test-viewer', name: 'Test', version: '1.0.0', capabilities: [{ kind: 'item:read' }] };
async function fixture(t, value = manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-validator-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'canopy.json'), JSON.stringify(value));
  await writeFile(join(dir, 'index.js'), 'throw new Error("must not execute")');
  return dir;
}
test('accepts a directory or manifest without executing its entry', async t => {
  const dir = await fixture(t);
  assert.equal((await validatePlugin(dir)).valid, true);
  assert.equal((await validatePlugin(join(dir, 'canopy.json'))).valid, true);
});
test('reports unknown capabilities and fields against the canonical schema', async t => {
  const result = await validatePlugin(await fixture(t, { ...manifest, capabilities: [{ kind: 'unrestricted' }], typo: true }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('typo')));
  assert.ok(result.errors.some(error => error.includes('/capabilities')));
});
test('rejects missing entries and symlinks escaping the plugin directory', async t => {
  const dir = await fixture(t, { ...manifest, entry: 'missing.js' });
  assert.equal((await validatePlugin(dir)).valid, false);
  await symlink(new URL(import.meta.url), join(dir, 'missing.js'));
  assert.match((await validatePlugin(dir)).errors[0], /inside/);
});
test('CLI returns a nonzero status for invalid input', async t => {
  const dir = await fixture(t, { ...manifest, version: 'bad' });
  const result = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version/);
});
