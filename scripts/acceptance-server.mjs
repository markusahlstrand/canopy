import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
// Recipient personas for the sharing, search and offline specs, one set per viewport.
const acceptancePersonas = ['desktop', 'mobile'].flatMap(viewport => ['viewer', 'editor', 'restricted', 'webdav'].map(role => ({
  sub: `acceptance|${viewport}|${role}`, name: `${viewport} ${role}`, email: `${viewport}-${role}@canopy.test`,
})));
const issuer = serve({ fetch: createDevIssuer({ personas: [...PERSONAS, ...acceptancePersonas] }).fetch, hostname: '127.0.0.1', port: 8989 });
// Local npm registry: serves the in-repo fixture package, packed by the real `npm pack`, so the
// successful npm import runs the real tarball/integrity path. Every other package is proxied to
// registry.npmjs.org with its tarball URL rewritten, keeping the "not a plugin" check on real data.
const fixtureDir = resolve('examples/npm/canopy-plugin-sample');
let packed, fixtureTarball;
try {
  packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', state], { cwd: fixtureDir, encoding: 'utf8' }))[0];
  fixtureTarball = await readFile(join(state, packed.filename));
} catch (error) {
  issuer.close();
  await rm(state, { recursive: true, force: true });
  throw error;
}
const fixturePackage = JSON.parse(await readFile(join(fixtureDir, 'package.json'), 'utf8'));
const registryPort = 8990, registryOrigin = `http://127.0.0.1:${registryPort}`;
const fixtureName = fixturePackage.name, fixtureFile = `${fixtureName}-${fixturePackage.version}.tgz`;
const registry = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]).slice(1);
    if (path === fixtureName) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        name: fixtureName, 'dist-tags': { latest: fixturePackage.version },
        versions: { [fixturePackage.version]: { name: fixtureName, version: fixturePackage.version, dist: {
          tarball: `${registryOrigin}/${fixtureName}/-/${fixtureFile}`,
          integrity: `sha512-${createHash('sha512').update(fixtureTarball).digest('base64')}`,
        } } },
      }));
    } else if (path === `${fixtureName}/-/${fixtureFile}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fixtureTarball);
    } else if (!/^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(?:\/-\/[a-z0-9~][a-z0-9._~-]*\.tgz)?$/.test(path)) {
      res.writeHead(404).end('not found');
    } else {
      const upstream = await fetch(`https://registry.npmjs.org/${path}`, { headers: { accept: req.headers.accept ?? '*/*' } });
      const body = Buffer.from(await upstream.arrayBuffer());
      const text = upstream.headers.get('content-type')?.includes('json') ? body.toString().replaceAll('https://registry.npmjs.org', registryOrigin) : undefined;
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' }).end(text ?? body);
    }
  } catch (error) { res.headersSent || res.writeHead(error instanceof URIError ? 400 : 502); res.end(String(error)); }
}).listen(registryPort, '127.0.0.1');
registry.on('error', async error => { console.error(error); issuer.close(); await rm(state, { recursive: true, force: true }); process.exit(1); });
const config = join(state, 'wrangler.json');
await writeFile(config, JSON.stringify({
  name: 'canopy-acceptance', main: resolve('apps/drive-vertical/src/worker.ts'),
  compatibility_date: '2026-06-01', compatibility_flags: ['nodejs_compat'],
  vars: { ALLOW_DEV_NODE: 'true', PLATFORM_SECRET: secret, ROUTER_SECRET: randomBytes(32).toString('hex'), NPM_REGISTRY_URL: registryOrigin },
  assets: { directory: resolve('apps/drive-vertical/app/dist'), binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/internal/*', '/dav', '/dav/*'] },
  r2_buckets: [{ binding: `BLOBS__${node.tenantId}`, bucket_name: 'canopy-acceptance' }],
  durable_objects: { bindings: ['SCOPE', 'AUTH', 'SWEEPER'].map((name, i) => ({ name, class_name: ['ScopeDO', 'IdentityDO', 'SweeperDO'][i] })) },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['ScopeDO', 'IdentityDO', 'SweeperDO'] }],
}));
const worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', config, '--ip', '127.0.0.1', '--port', '8987', '--persist-to', join(state, 'data')], {
  stdio: 'inherit', detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
let stopping = false;
let drain;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(drain);
  issuer.close();
  registry.close();
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
    const response = await fetch(`http://127.0.0.1:8987/internal/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-substrat-platform': secret }, body: JSON.stringify({ ...node, ...body }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
  console.log('Acceptance worker provisioned');
  // Only the external control plane is a fixture: consume the real durable
  // provision-sibling intent and call the same internal provision/configure/settle
  // surface it uses. UI mutations, identity binding and scope stores stay real.
  const scopes = [node.scopeId];
  let draining = false;
  const platform = async (path, scopeId, body) => {
    const response = await fetch(`http://127.0.0.1:8987/internal/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-substrat-platform': secret },
      body: JSON.stringify({ tenantId: node.tenantId, scopeId, ...body }),
    });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  };
  drain = setInterval(async () => {
    if (draining || stopping) return;
    draining = true;
    try {
      for (const scopeId of [...scopes]) {
        const response = await fetch(`http://127.0.0.1:8987/internal/platform-requests?tenantId=${node.tenantId}&scopeId=${scopeId}`, { headers: { 'x-substrat-platform': secret } });
        if (!response.ok) throw new Error(`Intent read failed: ${response.status}`);
        for (const request of await response.json()) {
          if (request.kind !== 'provision-sibling') continue;
          const sibling = `01${randomBytes(12).toString('hex').toUpperCase()}`;
          await platform('configure', sibling, { entries: [{ key: 'substrat:auth', value: JSON.stringify({ mode: 'oidc', issuer: 'http://127.0.0.1:8989', clientId: 'substrat-dev' }) }] });
          await platform('provision', sibling, request.payload);
          scopes.push(sibling);
          await platform('platform-requests/settle', scopeId, { id: request.id, status: 'done', result: { scopeId: sibling } });
        }
      }
    } catch (error) { if (!stopping) { console.error(error); await stop(1); } }
    finally { draining = false; }
  }, 200);
} catch (error) { console.error(error); await stop(1); }
