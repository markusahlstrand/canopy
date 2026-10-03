import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
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
  const capability = result.errors.filter(error => error.startsWith('/capabilities'));
  assert.equal(capability.length, 1);
  assert.match(capability[0], /^\/capabilities\/0\/kind "unrestricted" is not one of item:read, item:write/);
});
test('reports only the matching branch for a known capability kind', async t => {
  const result = await validatePlugin(await fixture(t, { ...manifest, capabilities: [{ kind: 'item:read', hosts: ['x'] }] }));
  assert.deepEqual(result.errors, ['/capabilities/0 must NOT have additional properties: hosts']);
});
test('rejects missing entries and symlinks escaping the plugin directory', async t => {
  const dir = await fixture(t, { ...manifest, entry: 'missing.js' });
  assert.equal((await validatePlugin(dir)).valid, false);
  await symlink(new URL(import.meta.url), join(dir, 'missing.js'));
  assert.match((await validatePlugin(dir)).errors[0], /inside/);
});
test('rejects entries a loader would read differently', async t => {
  for (const entry of ['./index.js', 'sub/../index.js', 'sub//index.js', '../index.js', 'sub\\index.js', '/index.js']) {
    const result = await validatePlugin(await fixture(t, { ...manifest, entry }));
    assert.equal(result.valid, false, entry);
    assert.match(result.errors[0], /entry must/, entry);
  }
});
test('names the manifest in parse errors and accepts a UTF-8 BOM', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'canopy.json'), '{ bad');
  assert.match((await validatePlugin(dir)).errors[0], new RegExp(`^${join(dir, 'canopy.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
  await writeFile(join(dir, 'canopy.json'), `\uFEFF${JSON.stringify(manifest)}`);
  assert.equal((await validatePlugin(dir)).valid, true);
});
test('manifest-only plugins skip the entry check', async t => {
  const dir = await fixture(t, { ...manifest, entry: 'missing.js' });
  assert.equal((await validatePlugin(dir, { manifestOnly: true })).valid, true);
});
test('every bundled example validates', async () => {
  const root = new URL('../../../examples/plugins/', import.meta.url);
  const examples = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(examples.length > 0);
  for (const name of examples) {
    const dir = new URL(`${name}/`, root).pathname;
    const codeless = !readdirSync(dir).some(file => /\.(m?js|html)$/.test(file));
    const result = await validatePlugin(dir, { manifestOnly: codeless });
    assert.deepEqual(result.errors, [], name);
  }
});
test('CLI returns a nonzero status for invalid input', async t => {
  const dir = await fixture(t, { ...manifest, version: 'bad' });
  const result = spawnSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version/);
});
test('CLI accepts --manifest-only and rejects extra arguments', async t => {
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const dir = await fixture(t, { ...manifest, entry: 'missing.js' });
  assert.equal(spawnSync(process.execPath, [cli, '--manifest-only', dir], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, dir, dir], { encoding: 'utf8' }).status, 2);
});
