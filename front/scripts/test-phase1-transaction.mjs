#!/usr/bin/env node
/**
 * Synthetic Phase1 browser/API transaction. No existing/demo tenant fallback.
 * Required env: PHASE1_FIXTURE=tmp/phase1-fixture.json, BASE_URL (same loopback
 * origin as fixture), PHASE1_LIVE_MODE=false, PHASE1_STRIPE_SECRET_KEY=sk_test_...,
 * PHASE1_OWNER_PASSWORD. Supply PUPPETEER_EXECUTABLE_PATH for local Chrome, or
 * PUPPETEER_CONNECT_URL for an existing loopback browser. No installs performed.
 *
 * node front/scripts/test-phase1-transaction.mjs --check
 *   Offline manifest/configuration validation only; no browser/network/writes.
 * node front/scripts/test-phase1-transaction.mjs --execute --allow-local-synthetic
 *   Explicitly creates a local synthetic order and a real Stripe TEST payment.
 *   Retains fixture/order/print job for inspection; never silently cleans up.
 *
 * Coverage: UI login/menu/KDS/reports; API checkout, retry idempotency, Stripe
 * test settlement, KDS item transition, receipt payload, report reconciliation.
 * Not covered: browser card entry/3DS, webhooks, restricted staff roles, hardware
 * printing, browser receipt layout, refunds, offline operation, production.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loginStaff } from './staff-login.mjs';

const passed = [];
const uncovered = ['card-entry UI/3DS', 'Stripe webhook delivery/retries',
  'restricted staff permissions', 'physical printing/browser receipt layout',
  'refunds/offline/production'];
let browser;
let fixture;
let stage = 'configuration';
let orderId;

function localOrigin(raw) {
  const url = new URL(raw);
  assert.equal(url.protocol, 'http:', 'HTTP loopback required');
  assert(['localhost', '127.0.0.1', '[::1]', 'haproxy'].includes(url.hostname),
    'Loopback or exact Compose host haproxy required');
  assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'Bare loopback origin required');
  return url.origin;
}

async function main() {
  const args = process.argv.slice(2);
  const stdin = args.includes('--credentials-stdin');
  const options = args.filter(arg => arg !== '--credentials-stdin');
  const remote = options.includes('--allow-remote-synthetic');
  const check = options.length === 1 && options[0] === '--check';
  assert(check || (options.length === 2 && options.includes('--execute') &&
    options.includes(remote ? '--allow-remote-synthetic' : '--allow-local-synthetic')),
  'Use --check or --execute with exactly one synthetic opt-in');
  assert.equal(process.env.PHASE1_LIVE_MODE, 'false', 'PHASE1_LIVE_MODE must be false');
  for (const key of ['APP_ENV', 'ENVIRONMENT', 'NODE_ENV']) {
    assert(remote || !['production', 'prod', 'live'].includes((process.env[key] || '').toLowerCase()),
      'Production environment refused');
  }
  const credentials = stdin ? JSON.parse(readFileSync(0, 'utf8')) : {};
  const secret = credentials.stripe_secret_key || process.env.PHASE1_STRIPE_SECRET_KEY || '';
  const ownerPassword = credentials.owner_password || process.env.PHASE1_OWNER_PASSWORD || '';
  assert(/^(sk|rk)_test_/.test(secret) && secret.length > 16, 'Stripe test secret required');
  assert(ownerPassword.length >= 14, 'Owner password required');
  assert(process.env.PHASE1_FIXTURE, 'PHASE1_FIXTURE is required');
  const envelope = JSON.parse(readFileSync(process.env.PHASE1_FIXTURE, 'utf8').replace(/^\uFEFF/, ''));
  assert(typeof envelope.payload === 'string' && /^[a-f0-9]{64}$/.test(envelope.signature),
    'Invalid signed fixture envelope');
  const expected = createHmac('sha256', secret).update(envelope.payload).digest();
  assert(timingSafeEqual(expected, Buffer.from(envelope.signature, 'hex')), 'Fixture signature mismatch');
  fixture = JSON.parse(envelope.payload);
  assert.equal(fixture.schema, 1);
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.livemode, false);
  assert(/^[a-f0-9]{32}$/.test(fixture.run_id), 'Invalid unique run ID');
  assert.equal(fixture.tenant_name, `Scanaki Phase 1 ${fixture.run_id}`);
  assert.equal(fixture.owner_email, `phase1-${fixture.run_id}@amvara.de`);
  assert.equal(fixture.product_name, `Synthetic Soup ${fixture.run_id}`);
  assert.equal(fixture.amount_cents, 500);
  assert.equal(fixture.currency, 'gbp');
  assert(/^[a-f0-9]{64}$/.test(fixture.publishable_key_sha256), 'Missing publishable-key fingerprint');
  const age = Date.now() / 1000 - fixture.created_at;
  assert(Number.isFinite(age) && age >= -30 && age <= 1800, 'Fixture expired or clock invalid');
  let base;
  if (remote) {
    assert.equal(process.env.PHASE1_ALLOW_REMOTE_SYNTHETIC, '1', 'Explicit remote env opt-in required');
    const url = new URL(process.env.BASE_URL || '');
    assert.equal(url.protocol, 'https:');
    assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
    base = url.origin;
    assert.equal(base, process.env.PHASE1_REMOTE_ORIGIN, 'Remote origin acknowledgement mismatch');
    assert.equal(fixture.target, 'remote');
  } else {
    base = localOrigin(process.env.BASE_URL || '');
    assert.equal(fixture.target, 'local');
  }
  assert.equal(base, fixture.base_url, 'Fixture origin mismatch');
  for (const key of ['tenant_id', 'location_id', 'table_id', 'product_id']) {
    assert(Number.isSafeInteger(fixture[key]) && fixture[key] > 0, `Invalid ${key}`);
  }
  passed.push('signed local synthetic manifest/configuration');
  if (check) {
    console.log(JSON.stringify({ result: 'configuration-only', run_id: fixture.run_id,
      passed, transaction_executed: false, uncovered }));
    return;
  }

  async function stripe(path, body) {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `phase1-${fixture.run_id}-confirm` } : {}) },
      body: body ? new URLSearchParams(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    assert(response.ok, `Stripe ${path.split('/')[0]} HTTP ${response.status}`);
    const result = await response.json();
    if (result.object === 'list') {
      assert(Array.isArray(result.data), 'Stripe list data missing');
      assert(result.data.every(item => item.livemode === false), 'Stripe list contains non-test object');
    } else {
      assert.equal(result.livemode, false, 'Stripe object must explicitly be test mode');
    }
    return result;
  }
  stage = 'Stripe test-mode preflight';
  await stripe('payment_intents?limit=1');
  passed.push(stage);
  const require = createRequire(import.meta.url);
  const puppeteer = require('puppeteer-core');
  if (process.env.PUPPETEER_CONNECT_URL) {
    localOrigin(process.env.PUPPETEER_CONNECT_URL);
    browser = await puppeteer.connect({ browserURL: process.env.PUPPETEER_CONNECT_URL });
  } else {
    assert(process.env.PUPPETEER_EXECUTABLE_PATH, 'PUPPETEER_EXECUTABLE_PATH required');
    browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  const staffContext = await browser.createBrowserContext();
  const guestContext = await browser.createBrowserContext();
  try {
    const staff = await staffContext.newPage();
    const guest = await guestContext.newPage();
    const pageErrors = [];
    for (const page of [staff, guest]) {
      page.on('pageerror', () => pageErrors.push('browser pageerror'));
      await page.evaluateOnNewDocument(() => localStorage.setItem('pos_language', 'en'));
      page.setDefaultTimeout(15000);
    }
    async function goto(page, path) {
      const response = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert(response?.ok(), `Page ${path.split('/')[1]} failed`);
      assert.equal(new URL(page.url()).origin, base, 'Cross-origin navigation refused');
    }
    async function api(page, path, method = 'GET', body) {
      const result = await page.evaluate(async ({ base, path, method, body }) => {
        const response = await fetch(`${base}/api${path}`, {
          method, credentials: 'include', redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        return { status: response.status, body: await response.json() };
      }, { base, path, method, body });
      assert(result.status >= 200 && result.status < 300,
        `Endpoint contract failed: ${method} ${path.split('?')[0]} HTTP ${result.status}`);
      return result.body;
    }
    async function poll(read, accept, label) {
      const deadline = Date.now() + 20000;
      do {
        const value = await read();
        if (accept(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 400));
      } while (Date.now() < deadline);
      throw new Error(`Timed out: ${label}`);
    }
    stage = 'staff login and tenant identity';
    await loginStaff(staff, { baseUrl: base, email: fixture.owner_email,
      password: ownerPassword, tenantId: fixture.tenant_id });
    const me = await api(staff, '/users/me');
    assert.equal(me.tenant_id, fixture.tenant_id);
    assert.equal(me.email, fixture.owner_email);
    const settings = await api(staff, '/tenant/settings');
    assert.equal(settings.name, fixture.tenant_name);
    assert(settings.stripe_publishable_key?.startsWith('pk_test_'), 'Backend publishable key is not test mode');
    assert.equal(createHash('sha256').update(settings.stripe_publishable_key).digest('hex'),
      fixture.publishable_key_sha256, 'Backend publishable key changed');
    assert.equal(settings.stripe_payment_mode, 'tenant_keys');
    assert(!settings.stripe_connected_account_id, 'Connect mode refused');
    assert.equal(settings.ordering_mode, 'automatic');
    assert.equal(settings.immediate_payment_required, true);
    const tables = await api(staff, '/tables');
    assert(tables.some(t => t.id === fixture.table_id && t.token === fixture.table_token &&
      t.location_id === fixture.location_id),
      'Fixture table mismatch');
    assert.deepEqual(await api(staff, '/orders'), [], 'Fixture already used: create a fresh run');
    passed.push(stage);

    const date = new Date().toISOString().slice(0, 10);
    const reportPath = `/reports/sales?from_date=${date}&to_date=${date}`;
    const before = await api(staff, reportPath);
    assert.equal(before.summary.total_orders, 0);
    assert.equal(before.summary.total_revenue_cents, 0);
    stage = 'guest menu UI and API checkout/idempotency';
    await goto(guest, `/menu/${encodeURIComponent(fixture.table_token)}`);
    await guest.waitForSelector('[data-testid="ordering-product-card"]');
    await guest.waitForFunction(name => document.body.innerText.includes(name), {}, fixture.product_name);
    const menu = await api(guest, `/menu/${encodeURIComponent(fixture.table_token)}`);
    assert(menu.products.some(p => p.id === fixture.product_id && p.price_cents === 500),
      'Synthetic menu product contract mismatch');
    const orderPath = `/menu/${encodeURIComponent(fixture.table_token)}/order`;
    const body = { items: [{ product_id: fixture.product_id, source: 'product', quantity: 1 }],
      session_id: fixture.run_id, idempotency_key: fixture.run_id,
      customer_name: `Synthetic ${fixture.run_id}`, notes: fixture.run_id };
    const created = await api(guest, orderPath, 'POST', body);
    orderId = created.order_id;
    assert(Number.isSafeInteger(orderId) && orderId > 0, 'Missing order_id');
    assert.equal(created.payment_required, true);
    assert.equal((await api(guest, orderPath, 'POST', body)).order_id, orderId);
    const hidden = await api(staff, '/orders/kitchen-feed');
    assert(!hidden.some(o => o.id === orderId), 'Unpaid order leaked to KDS');
    passed.push(stage);

    stage = 'Stripe test settlement and server confirmation';
    const query = new URLSearchParams({ table_token: fixture.table_token, session_id: fixture.run_id });
    const intent = await api(guest, `/orders/${orderId}/create-payment-intent?${query}`, 'POST');
    assert.equal(intent.amount, 500);
    assert(/^pi_[A-Za-z0-9]+$/.test(intent.payment_intent_id), 'Invalid payment intent ID');
    const payment = await stripe(`payment_intents/${intent.payment_intent_id}`);
    assert.equal(payment.amount, 500);
    assert.equal(payment.currency, 'gbp');
    assert.equal(payment.metadata.tenant_id, String(fixture.tenant_id));
    assert.equal(payment.metadata.order_id, String(orderId));
    assert.equal(payment.metadata.location_id, String(fixture.location_id));
    assert.equal(payment.metadata.payment_account_snapshot, 'tenant-default');
    assert.equal(payment.status, 'requires_payment_method');
    const confirmed = await stripe(`payment_intents/${payment.id}/confirm`, {
      payment_method: 'pm_card_visa', return_url: `${base}/menu/${fixture.table_token}/payment-success`,
    });
    assert.equal(confirmed.status, 'succeeded', 'Stripe test confirmation did not succeed');
    query.set('payment_intent_id', payment.id);
    const settlement = await api(guest, `/orders/${orderId}/confirm-payment?${query}`, 'POST');
    assert.equal(settlement.status, 'paid');
    const ledger = await api(staff, `/orders/${orderId}/payments`);
    assert.equal(ledger.amount_paid_cents, 500);
    assert.equal(ledger.amount_remaining_cents, 0);
    passed.push(stage);

    stage = 'KDS UI visibility and API fulfillment';
    const feed = await poll(() => api(staff, '/orders/kitchen-feed'),
      rows => rows.some(o => o.id === orderId), 'paid order in KDS');
    const order = feed.find(o => o.id === orderId);
    assert.equal(order.items.length, 1);
    await goto(staff, '/kitchen');
    await staff.waitForFunction(name => document.body.innerText.includes(name), {}, fixture.product_name);
    for (const status of ['preparing', 'ready', 'delivered']) {
      await api(staff, `/orders/${orderId}/items/${order.items[0].id}/status`, 'PUT', { status });
    }
    await poll(() => api(staff, '/orders'), rows => rows.some(o =>
      o.id === orderId && o.status === 'completed'), 'completed paid order');
    passed.push(stage);

    stage = 'receipt API payload';
    const receipt = await api(staff, '/print-jobs', 'POST', {
      job_type: 'receipt', order_id: orderId, printer_role: 'receipt',
    });
    assert.equal(receipt.job.order_id, orderId);
    assert.equal(receipt.job.payload.total_cents, 500);
    assert.equal(receipt.job.payload.lines.length, 1);
    assert.equal(receipt.job.payload.lines[0].name, fixture.product_name);
    assert.equal(receipt.job.payload.lines[0].quantity, 1);
    passed.push(stage);

    stage = 'reports API reconciliation and UI';
    assert.equal(new Date().toISOString().slice(0, 10), date, 'Run crossed UTC midnight; use a fresh fixture');
    const after = await api(staff, reportPath);
    assert.equal(after.summary.total_orders, 1);
    assert.equal(after.summary.total_revenue_cents, 500);
    await goto(staff, '/reports');
    await staff.waitForSelector('[data-testid="reports-page"]');
    assert.equal(pageErrors.length, 0, 'Browser JavaScript errors occurred');
    passed.push(stage);
    console.log(JSON.stringify({ result: 'passed-bounded-coverage', run_id: fixture.run_id,
      tenant_id: fixture.tenant_id, order_id: orderId, passed, uncovered,
      retained: 'Synthetic tenant, test payment, order and receipt job; no cleanup performed' }));
  } finally {
    await guestContext.close();
    await staffContext.close();
  }
}

try {
  await main();
} catch (error) {
  // Do not dump responses, browser URLs, credentials, client secrets or stacks.
  console.error(JSON.stringify({ result: 'failed', stage, run_id: fixture?.run_id,
    order_id: orderId, passed, uncovered,
    reason: error instanceof assert.AssertionError ? error.message.split('\n')[0]
      : error.message?.startsWith('Timed out:') || error.message?.startsWith('Staff login failed at ')
        ? error.message : error.name }));
  process.exitCode = 1;
} finally {
  if (browser) {
    if (process.env.PUPPETEER_CONNECT_URL) browser.disconnect();
    else await browser.close();
  }
}
