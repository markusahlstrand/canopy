import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createDevIssuer } from '@substrat-run/dev-issuer';
import { PERSONAS } from './dev-personas.mjs';

// Run the built SPA and real worker with an empty, disposable DO/R2 store. Neither
// the user's pnpm dev state nor any hosted install is read or mutated here.
const state = await mkdtemp(join(tmpdir(), 'canopy-acceptance-'));
const secret = randomBytes(32).toString('hex');
const node = { tenantId: '01JZ00000000000000000DEV01', scopeId: '01JZ00000000000000000DEV02' };
const issuer = serve({ fetch: createDevIssuer({ personas: PERSONAS }).fetch, hostname: '127.0.0.1', port: 8989 });
const config = join(state, 'wrangler.json');
await writeFile(config, JSON.stringify({
  name: 'canopy-acceptance', main: resolve('apps/drive-vertical/src/worker.ts'),
  compatibility_date: '2026-06-01', compatibility_flags: ['nodejs_compat'],
  vars: { ALLOW_DEV_NODE: 'true', PLATFORM_SECRET: secret, ROUTER_SECRET: randomBytes(32).toString('hex') },
  assets: { directory: resolve('apps/drive-vertical/app/dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/internal/*'] },
  r2_buckets: [{ binding: `BLOBS__${node.tenantId}`, bucket_name: 'canopy-acceptance' }],
  durable_objects: { bindings: ['SCOPE', 'AUTH', 'SWEEPER'].map((name, i) => ({ name, class_name: ['ScopeDO', 'IdentityDO', 'SweeperDO'][i] })) },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ScopeDO', 'IdentityDO', 'SweeperDO'] }],
}));
const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', config, '--ip', '127.0.0.1', '--port', '8987', '--persist-to', join(state, 'data')], {
  stdio: 'inherit', detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  issuer.close();
  try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* already stopped */ }
  await new Promise(done => worker.exitCode !== null ? done() : worker.once('exit', done));
  await rm(state, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
worker.on('error', error => { console.error(error); void stop(1); });
worker.on('exit', code => { if (!stopping) void stop(code || 1); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:8987/internal/owner-seat?tenantId=${node.tenantId}&scopeId=${node.scopeId}`, { headers: { 'x-substrat-platform': secret }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* starting */ }
    await delay(500);
  }
  if (!ready) throw new Error('Acceptance worker did not start');
  for (const [path, body] of [
    ['configure', { entries: [{ key: 'substrat:auth', value: JSON.stringify({ mode: 'oidc', issuer: 'http://127.0.0.1:8989', clientId: 'substrat-dev' }) }] }],
    ['provision', { owner: '01JZ00000000000000000DEV03', slug: 'local-drive', name: 'Acceptance Drive' }],
  ]) {
    const response = await fetch(`http://127.0.0.1:8987/internal/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-substrat-platform': secret }, body: JSON.stringify({ ...node, ...body }) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
  console.log('Acceptance worker provisioned');
} catch (error) { console.error(error); await stop(1); }
