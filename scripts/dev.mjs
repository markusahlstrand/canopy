import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Local harness only. Provision through the same platform surface as an install;
// authentication remains an ordinary OIDC round trip with a persona picker.
const node = { tenantId: '01JZ00000000000000000DEV01', scopeId: '01JZ00000000000000000DEV02' };
const secret = randomBytes(32).toString('hex');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
}
function run(args) {
  const child = spawn('pnpm', args, { stdio: 'inherit', detached: true });
  children.push(child);
  child.on('error', (error) => { console.error(error); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code || 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

async function waitFor(url, headers) {
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* The process is still starting. */ }
    await delay(500);
  }
  throw new Error(`Local service did not start: ${url}`);
}
async function platform(path, body) {
  const response = await fetch(`http://localhost:8787/internal/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': secret },
    body: JSON.stringify({ ...node, ...body }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
}

try {
  run(['exec', 'node', 'scripts/dev-issuer.mjs']);
  run(['--filter', '@canopy/drive-vertical', 'dev', '--ip', '127.0.0.1', '--port', '8787', '--var', `PLATFORM_SECRET:${secret}`]);
  await Promise.all([
    waitFor('http://localhost:8879/.well-known/openid-configuration'),
    waitFor(`http://localhost:8787/internal/owner-seat?tenantId=${node.tenantId}&scopeId=${node.scopeId}`, { 'x-substrat-platform': secret }),
  ]);
  await platform('configure', { entries: [{ key: 'substrat:auth', value: JSON.stringify({
    mode: 'oidc', issuer: 'http://localhost:8879', clientId: 'substrat-dev',
  }) }] });
  await platform('provision', { owner: '01JZ00000000000000000DEV03', slug: 'local-drive', name: 'Local Drive' });
  run(['dev:web']);
  console.log('\nCanopy: http://localhost:5769 — sign in as Local Owner to claim the local drive.\n');
} catch (error) {
  console.error(error);
  stop(1);
}
