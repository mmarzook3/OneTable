import { spawnSync } from 'node:child_process';

// Public, read-only baseline. Authenticated transaction acceptance is a separate gate.
const baseUrl = process.env.BASE_URL;
if (!baseUrl) throw new Error('BASE_URL is required; no implicit production target.');
const target = new URL(baseUrl);
if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Expected an HTTP URL.');
for (const path of ['/api/health', '/api/health/ready']) {
  const response = await fetch(new URL(path, target), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body = await response.json();
  const healthy = path === '/api/health/ready'
    ? body.status === 'ready' && body.database === 'ok' && body.redis === 'ok'
    : body.status === 'ok';
  if (!healthy) throw new Error(`${path}: unhealthy status`);
  console.log(`PASS ${path}`);
}
for (const script of ['test-landing-version.mjs', 'test-api-docs.mjs']) {
  const result = spawnSync(process.execPath, [new URL(script, import.meta.url).pathname], {
    stdio: 'inherit',
    env: { ...process.env, LANDING_VERSION_ONLY: '1', HEADLESS: '1' },
    timeout: 180000,
  });
  if (result.error || result.status !== 0) {
    console.error(`FAIL ${script}: ${result.error?.message || result.status}`);
    process.exit(1);
  }
}
console.log('PASS public pilot baseline. Transaction and device acceptance remain separate.');
